# Phase 8: Pub/Sub channel cho cross-instance notify

> ⏱️ **Thời gian:** 20 phút
> 🎯 **Mục tiêu:** Sau khi Worker xử lý xong, broadcast `channel_unread` tới tất cả Node instance
> 📍 **Vị trí code:** `src/queues/unread.worker.ts` (sửa) + `src/queues/unread.subscriber.ts` (mới) + `src/socket/socket-instance.ts` (mới)

---

## 🎯 Vấn đề hiện tại

Sau Phase 7, Worker xử lý job xong nhưng **không emit gì cho user** (chỉ log).

**Vấn đề cross-instance:**

```
Worker (Instance A) xử lý job xong
  → Cần emit "channel_unread" cho user 20
  → User 20 đang kết nối ở Instance B
  → io.to("user:20").emit(...) ở Instance A → KHÔNG đến
```

→ Cần 1 cơ chế để **Instance A nói "có job xong" cho tất cả instance khác**, mỗi instance tự emit cho user ở local.

---

## 📚 Lý thuyết tối thiểu

### Pub/Sub pattern (Publish/Subscribe)

```
Publisher: PUBLISH channel message
  ↓
Redis
  ↓ (fanout)
Subscriber 1: nhận message → xử lý
Subscriber 2: nhận message → xử lý
```

**Đặc điểm:**
- Publisher không biết có bao nhiêu subscriber.
- Subscriber nhận message gần như ngay (~0.5ms trong cùng DC).
- Không persist — nếu subscriber down → miss message.

### Phân biệt với BullMQ

| | Pub/Sub | BullMQ |
|---|---------|--------|
| **Mục đích** | Broadcast real-time | Async job processing |
| **Persistence** | ❌ Không | ✅ Có (đến khi removeOnComplete) |
| **Retry** | ❌ Không | ✅ Có (attempts + backoff) |
| **Consumer groups** | ❌ Mọi sub nhận hết | ✅ Competing |
| **Latency** | < 1ms | 10-50ms |

→ Dùng **BullMQ cho job nặng** (DB write), **Pub/Sub cho broadcast nhẹ** (notify instance).

### Tại sao cần Pub/Sub riêng (không dùng BullMQ)?

BullMQ competing consumer → job chỉ đi đến 1 worker. Nhưng ở đây ta muốn **TẤT CẢ instance đều nhận** → dùng Pub/Sub.

---

## 💻 Bước 1: Tạo helper `src/socket/socket-instance.ts`

File này giúp mọi nơi trong app đều truy cập được `io` instance (vì `socket.ts` đã có biến local).

```typescript
import type { Server } from 'socket.io'

// Lưu io instance ở module-level
let ioInstance: Server | null = null

export const setIO = (io: Server) => {
  ioInstance = io
}

export const getIO = (): Server | null => ioInstance
```

Mở `src/socket/socket.ts`, tìm chỗ tạo `io` (sau `io = new Server(...)`), thêm:

```typescript
import { setIO } from './socket-instance'

io = new Server(httpSocket, { ... })
setIO(io)  // ← thêm dòng này
```

---

## 💻 Bước 2: Sửa Worker publish lên Pub/Sub

Mở `src/queues/unread.worker.ts`. Trong processor function, **trước khi return**, thêm publish:

```typescript
import { createClient } from 'redis'

// Tạo publisher riêng (1 connection cho cả worker process)
const publisher = createClient({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379'
})
publisher.connect().then(() => {
  console.log('[Unread Publisher] connected')
})

// Trong processor function, cuối hàm:
async (job: Job<UnreadBatchJob>) => {
  const { events } = job.data
  if (events.length === 0) return { processed: 0 }
  
  console.log(`[Unread Worker] processing ${events.length} events`)
  
  // ============ LOGIC CHÍNH ============
  // 1. Gom recipients cho mỗi event
  // (Tạm thời: gom tất cả userIds từ tất cả events)
  
  const allRecipients = new Set<number>()
  for (const event of events) {
    // Lấy members của channel từ cache (Phase 1)
    const members = await redis.smembers(`channel:${event.channelId}:members`)
    members.forEach(m => {
      const uid = Number(m)
      if (uid !== event.senderId) {
        allRecipients.add(uid)
      }
    })
  }
  
  // 2. Publish lên Pub/Sub channel
  await publisher.publish('chat:notify:unread', JSON.stringify({
    type: 'unread_batch',
    recipientIds: Array.from(allRecipients),
    messageCount: events.length
  }))
  
  console.log(`[Unread Worker] published notify for ${allRecipients.size} recipients`)
  
  return { processed: events.length, recipients: allRecipients.size }
}
```

**Tại sao `Set`?**
- Loại bỏ duplicate (1 user có thể ở nhiều channel).
- O(1) add/check.

---

## 💻 Bước 3: Tạo Subscriber `src/queues/unread.subscriber.ts`

```typescript
import { createClient } from 'redis'
import { getIO } from '~/socket/socket-instance'
import { Socket_Room } from '~/socket/utils'

// Connection riêng cho subscribe
const subscriber = createClient({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379'
})

interface NotifyPayload {
  type: 'unread_batch'
  recipientIds: number[]
  messageCount: number
}

/**
 * Subscribe Pub/Sub channel chat:notify:unread
 * Mỗi instance sẽ chạy 1 subscriber → nhận tất cả message
 * → tự emit cho user ở local
 */
export const startUnreadSubscriber = async () => {
  await subscriber.connect()
  
  await subscriber.subscribe('chat:notify:unread', (raw) => {
    try {
      const data = JSON.parse(raw) as NotifyPayload
      
      // Lấy io instance hiện tại
      const io = getIO()
      if (!io) {
        console.warn('[Subscriber] no io instance')
        return
      }
      
      // Emit cho từng recipient
      for (const uid of data.recipientIds) {
        io.to(Socket_Room.user(uid.toString())).emit('channel_unread_batch', {
          type: data.type,
          messageCount: data.messageCount,
          timestamp: Date.now()
        })
      }
      
      console.log(`[Subscriber] emitted to ${data.recipientIds.length} users`)
    } catch (err) {
      console.error('[Subscriber] error:', err)
    }
  })
  
  console.log('[Subscriber] listening on chat:notify:unread')
}
```

**Giải thích:**
- `getIO()` lấy io instance từ socket-instance.ts.
- `io.to(user:N).emit(...)` chỉ emit cho socket ở local instance.
- Mỗi Node instance có 1 subscriber → cùng nhận message → tự emit cho user ở local.

---

## 💻 Bước 4: Khởi động Subscriber

Mở `src/index.ts`:

```typescript
import { startUnreadSubscriber } from '~/queues/unread.subscriber'

if (process.env.NODE_ENV !== 'test') {
  startUnreadAggregator()
  startUnreadWorker()
  startUnreadSubscriber()  // ← thêm
}
```

Restart server, console phải log:
- `[Subscriber] connected`
- `[Subscriber] listening on chat:notify:unread`
- `[Unread Publisher] connected`

---

## 💻 Bước 5: (Optional) Đơn giản hóa nếu chỉ có 1 instance

Nếu bạn chưa cần scale, có thể bỏ qua pub/sub và gọi trực tiếp trong worker:

```typescript
// Trong worker processor, thay vì publish:
const io = getIO()
if (io) {
  for (const uid of allRecipients) {
    io.to(Socket_Room.user(uid.toString())).emit('channel_unread_batch', {...})
  }
}
```

→ Đơn giản hơn, nhưng KHÔNG scale được multi-instance.

**Khuyến nghị:** Làm theo cách pub/sub để sẵn sàng scale.

---

## ✅ Checkpoint Phase 8

### Test single instance

1. **Restart server:**
   ```bash
   npm run dev
   ```
   
   Console phải log:
   ```
   [Aggregator] started, flush every 1000ms
   [BullMQ] worker + aggregator started
   [Subscriber] listening on chat:notify:unread
   [Unread Publisher] connected
   ```

2. **Gửi 1 message:**
   - Server log:
     - `[Aggregator] flushed 1 events to 1 job`
     - `[Unread Worker] processing 1 events`
     - `[Unread Worker] published notify for N recipients`
     - `[Subscriber] emitted to N users`
   - Client nhận event `channel_unread_batch`.

3. **Verify trong redis-cli:**
   ```bash
   docker exec -it chat-redis redis-cli
   ```
   ```redis
   PUBSUB CHANNELS
   ```
   Phải thấy `chat:notify:unread` trong danh sách.
   
   ```redis
   PUBSUB NUMSUB chat:notify:unread
   ```
   Trả về số subscriber (1 cho 1 instance).

### Test multi-instance

1. **Terminal 1:** `PORT=3001 npm run dev`
2. **Terminal 2:** `PORT=3002 npm run dev`

Cả 2 đều log `[Subscriber] listening on chat:notify:unread`.

```redis
PUBSUB NUMSUB chat:notify:unread
```

Trả về 2 (2 subscribers).

3. **Test:** Gửi message, cả 2 terminal đều log `[Subscriber] emitted to N users`.

### Checklist

- [ ] `socket-instance.ts` đã tạo, `setIO` được gọi trong `socket.ts`
- [ ] `unread.worker.ts` publish lên `chat:notify:unread`
- [ ] `unread.subscriber.ts` đã tạo, listen channel đó
- [ ] `index.ts` gọi `startUnreadSubscriber()`
- [ ] Test single instance: gửi message → user nhận `channel_unread_batch`
- [ ] Test multi-instance: cả 2 instance đều log subscriber nhận
- [ ] `PUBSUB NUMSUB` cho số đúng instance

---

## 🐛 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|-----|-------------|----------|
| `no io instance` | `setIO` chưa gọi | Check lại `socket.ts` |
| User không nhận event | `Socket_Room.user(uid)` sai format | Check helper |
| Subscriber không nhận | Channel name sai | Phải khớp publisher và subscriber |
| Multi-instance: 1 instance nhận, 1 không | Stuck subscribe | Check connection của instance bị miss |
| `Cannot read property 'to' of null` | `io` null | `getIO()` trả null, thêm check |

### Debug

Thêm log đầy đủ:

```typescript
// Trong subscriber
await subscriber.subscribe('chat:notify:unread', (raw) => {
  console.log('[Subscriber] RAW message:', raw)
  // ... xử lý
})
```

```typescript
// Trong worker publisher
console.log('[Worker] publishing:', payload)
await publisher.publish(...)
```

Xoá log sau khi test xong.

---

## 📊 Kết quả Phase 8

| Tính năng | Trước Phase 8 | Sau |
|-----------|---------------|-----|
| Cross-instance notify | ❌ | ✅ |
| Unread real-time | Sau 1-2s qua Worker | Sau 1-2s qua Pub/Sub |
| Scale ngang Worker | ❌ | ✅ Competing consumers |
| Scale ngang WebSocket | ✅ từ Phase 4 | ✅ + nhận pub/sub |

**Toàn bộ pipeline hoàn chỉnh:**
```
send_message
  → Insert DB (1ms)
  → LPUSH buffer (0.5ms)
  → [1 giây sau]
  → Flush thành job
  → Worker pickup + xử lý (5-50ms)
  → PUBLISH chat:notify:unread
  → All instances subscribe → emit cho user local
```

---

## ⏭️ Phase tiếp theo

**[Phase 9: Tổng hợp & kiểm thử →](./phase-09-test-verify.md)**

Phase cuối: verify toàn bộ pipeline, đo lường metrics, thêm health check endpoint.
