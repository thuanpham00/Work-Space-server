# Phase 7: Aggregator - Buffer trước khi đẩy Queue

> ⏱️ **Thời gian:** 30 phút
> 🎯 **Mục tiêu:** Gom 100 message trong 1 giây thành 1 job (giảm 100x job count)
> 📍 **Vị trí code:** `src/queues/unread.aggregator.ts` (mới) + `src/socket/utils.ts` (sửa)

---

## 🎯 Vấn đề hiện tại

Nếu mỗi message → 1 job BullMQ:

```
1000 message / giây = 1000 job / giây
→ 1000 lần Redis LPUSH (Producer)
→ 1000 lần worker pickup
→ Worker overhead: ~5ms × 1000 = 5 giây CHỈ ĐỂ PICKUP
```

**Tính toán với traffic thật:**
- Channel 1000 members, 10 user gửi 5 msg/phút = 50 msg/phút.
- 50 msg/phút = ~0.83 msg/giây → OK với 1 job/msg.
- Nhưng nếu traffic cao hơn (50 msg/giây) → 50 job/giây → worker overload.

**Giải pháp:** Buffer pattern — gom nhiều event thành 1 job.

---

## 📚 Lý thuyết tối thiểu

### Buffer pattern

```
Mỗi message → LPUSH vào List Redis (1ms)      [Producer nhẹ]
Mỗi 1 giây → LRANGE toàn bộ, gom 1 job        [Flush]
Worker xử lý 1 job với N events                [Consumer]

1000 msg/s → 1 job/s (gồm ~1000 events)
```

### Tại sao dùng List làm buffer?

List trong Redis:
- `LPUSH` — thêm vào đầu, O(1).
- `LRANGE 0 -1` — lấy tất cả.
- `LLEN` — đếm.
- `LTRIM` — giữ lại N phần tử đầu.
- `DEL` — xoá key.

Cấu trúc FIFO (First In First Out) tự nhiên — event cũ ở cuối list, xử lý theo thứ tự.

### Cấu trúc key

```
Key:    chat:unread:buffer
Type:   List
Items:  ["{...event1}", "{...event2}", ...]
```

### Race condition khi flush

**Vấn đề:**
```
t=1.0s: setInterval trigger
  → LRANGE lấy 100 events
  → ... đang xử lý ...
t=1.0s (cùng lúc): enqueueUnread push event mới
  → LPUSH vào buffer (vẫn còn data)
  → setInterval tiếp theo (t=2.0s) sẽ lấy cả event mới
```

→ OK vì ta `DEL` buffer TRƯỚC khi xử lý, event mới push sau đó vào buffer rỗng.

**Quan trọng:** `LRANGE` → `DEL` → `queue.add()` (theo thứ tự này).

### LTRIM chống tràn

```redis
LTRIM buffer 0 9999   ← chỉ giữ 10000 phần tử đầu
```

Phòng trường hợp worker chết, buffer phình vô hạn.

---

## 💻 Bước 1: Tạo file `src/queues/unread.aggregator.ts`

```typescript
import { unreadQueue } from './queue'
import IORedis from 'ioredis'

// ============ CONFIG ============
const FLUSH_INTERVAL = 1000  // Flush mỗi 1 giây
const BUFFER_MAX_SIZE = 10000  // Chống tràn nếu worker chết

// ============ TYPES ============
export interface UnreadEvent {
  channelId: number
  workspaceId: number
  senderId: number
  messageId: number
  createdAt: string
}

// ============ CONNECTION ============
// Connection riêng (không dùng singleton ioredis để tránh conflict)
const connection = new IORedis(
  process.env.REDIS_URL ?? 'redis://localhost:6379',
  { maxRetriesPerRequest: null }
)

const BUFFER_KEY = 'unread:buffer'

// ============ PRODUCER ============

/**
 * Đẩy 1 event vào buffer. Gọi ngay trong main flow.
 * Hàm này cực nhanh (~1ms), không block.
 */
export const enqueueUnread = async (event: UnreadEvent): Promise<void> => {
  // LPUSH thêm vào đầu list
  await connection.lpush(BUFFER_KEY, JSON.stringify(event))
  
  // LTRIM giữ tối đa BUFFER_MAX_SIZE phần tử (chống tràn)
  await connection.ltrim(BUFFER_KEY, 0, BUFFER_MAX_SIZE - 1)
}

// ============ CONSUMER (FLUSH SCHEDULER) ============

/**
 * Scheduler: cứ 1 giây, flush buffer thành 1 job.
 * Gọi 1 lần khi khởi động server.
 */
export const startUnreadAggregator = () => {
  setInterval(async () => {
    try {
      // 1. Lấy tất cả events trong buffer
      const events = await connection.lrange(BUFFER_KEY, 0, -1)
      
      if (events.length === 0) return  // Không có gì → skip
      
      // 2. Xoá buffer NGAY (trước khi xử lý)
      // Tránh race condition: event mới push vào sẽ vào buffer rỗng
      await connection.del(BUFFER_KEY)
      
      // 3. Parse JSON, loại bỏ event lỗi
      const parsed = events
        .map(e => {
          try {
            return JSON.parse(e) as UnreadEvent
          } catch {
            return null
          }
        })
        .filter((e): e is UnreadEvent => e !== null)
      
      if (parsed.length === 0) return
      
      // 4. Push 1 job gồm N events vào BullMQ
      await unreadQueue.add('batch', { events: parsed })
      
      console.log(`[Aggregator] flushed ${parsed.length} events to 1 job`)
    } catch (err) {
      console.error('[Aggregator] error:', err)
    }
  }, FLUSH_INTERVAL)
  
  console.log(`[Aggregator] started, flush every ${FLUSH_INTERVAL}ms`)
}
```

---

## 🔍 Giải thích code

### Hàm `enqueueUnread` (Producer)

```typescript
await connection.lpush(BUFFER_KEY, JSON.stringify(event))
```

**Giải thích:**
- `LPUSH` thêm vào **đầu** list.
- `JSON.stringify(event)` convert object → string (Redis chỉ lưu string).
- Tốn ~0.5ms.

```typescript
await connection.ltrim(BUFFER_KEY, 0, BUFFER_MAX_SIZE - 1)
```

**Giải thích:**
- `LTRIM key start stop` — giữ lại các phần tử từ index `start` đến `stop`.
- `LTRIM buffer 0 9999` — giữ 10000 phần tử đầu, xoá phần còn lại.
- Phòng worker chết → buffer phình → Redis đầy.

### Hàm `startUnreadAggregator` (Consumer - flush scheduler)

```typescript
setInterval(async () => {...}, FLUSH_INTERVAL)
```

**Giải thích:**
- `setInterval` chạy callback mỗi N ms.
- Chỉ gọi 1 lần khi khởi động → setInterval sẽ tự lặp mãi mãi.
- Để dừng: `clearInterval(handle)` (không cần trong app này).

**Quan trọng:** Thứ tự trong handler phải là **LRANGE → DEL → queue.add**:

```typescript
const events = await connection.lrange(...)  // 1. Lấy data
await connection.del(BUFFER_KEY)              // 2. Xoá buffer
await unreadQueue.add(...)                    // 3. Push job
```

Nếu đảo lại (DEL trước LRANGE) → mất data.
Nếu queue.add trước DEL → event mới có thể bị xoá mất.

### Type guard cho filter

```typescript
.filter((e): e is UnreadEvent => e !== null)
```

**Giải thích:**
- TypeScript không tự suy ra kiểu sau `filter`.
- `(e): e is UnreadEvent` là **type predicate** — báo cho TS biết `e` chắc chắn là `UnreadEvent` (không null) sau filter.
- Cú pháp đặc biệt, không phải arrow function thường.

---

## 💻 Bước 2: Khởi động Aggregator

Mở `src/index.ts`:

```typescript
import startUnreadAggregator from '~/queues/unread.aggregator'
import startUnreadWorker from '~/queues/unread.worker'

// ... existing code

if (process.env.NODE_ENV !== 'test') {
  startUnreadAggregator()  // ← thêm
  startUnreadWorker()
  console.log('[BullMQ] worker + aggregator started')
}
```

Console phải log `[Aggregator] started, flush every 1000ms`.

---

## 💻 Bước 3: Sửa `handleSendMessage` dùng enqueue

Mở `src/socket/utils.ts`, tìm hàm `handleSendMessage`. Tìm chỗ gọi `emitUnreadChannel`.

**Trước:**

```typescript
async function handleSendMessage(io, data) {
  // ... insert message + attachments
  
  // Gọi hàm này SYNC (chờ xong)
  await emitUnreadChannel(io, {
    channelId, senderId: userId, latestMessageId: Number(message.id)
  })
}
```

**Sau:**

```typescript
import { enqueueUnread } from '~/queues/unread.aggregator'
import { getChannelWorkspaceId } from '~/services/redis.services'

async function handleSendMessage(io, data) {
  // ... insert message + attachments
  
  // Lấy workspaceId từ cache (Phase 2)
  const workspaceId = await getChannelWorkspaceId(channelId)
  if (workspaceId === null) return
  
  // Đẩy vào buffer - fire-and-forget (không await)
  enqueueUnread({
    channelId,
    workspaceId,
    senderId: userId,
    messageId: Number(message.id),
    createdAt: new Date().toISOString()
  }).catch(err => console.error('[enqueueUnread]', err))
  
  // Trả response ngay, không đợi worker xử lý
}
```

**Tại sao fire-and-forget (không await)?**

```typescript
// ❌ Blocking - main flow chờ
await enqueueUnread(event)  // 1ms, không nhiều nhưng vẫn chờ

// ✅ Non-blocking - main flow tiếp tục ngay
enqueueUnread(event).catch(err => console.error(err))
```

1ms rất nhỏ, nhưng ở scale cao:
- 1000 msg/s × 1ms = 1 giây blocking → nghiêm trọng.
- Fire-and-forget cho scheduler xử lý.

### Giữ hay xoá `emitUnreadChannel`?

Tùy chiến lược:

**Cách 1 (khuyến nghị): Xoá `emitUnreadChannel`, dùng Aggregator + Worker + Subscriber (Phase 8).**
- Toàn bộ xử lý async, main flow cực nhanh.
- Eventual consistency: user nhận unread sau 1-2s.

**Cách 2 (đơn giản): Giữ `emitUnreadChannel` real-time + dùng Aggregator cho analytics.**
- Real-time cho UX, async cho việc khác.
- Phức tạp hơn nhưng UX tốt hơn.

Tài liệu này hướng dẫn **Cách 1** (xoá `emitUnreadChannel`).

→ **Xoá hoặc comment out** đoạn gọi `emitUnreadChannel` trong `handleSendMessage`.

---

## ✅ Checkpoint Phase 7

### Test

1. **Restart server:**
   ```bash
   npm run dev
   ```
   
   Console phải log:
   - `[BullMQ] worker + aggregator started`
   - `[Aggregator] started, flush every 1000ms`

2. **Gửi 1 message trong app:**
   - Trong redis-cli:
     ```bash
     docker exec -it chat-redis redis-cli
     ```
     ```redis
     LRANGE chat:unread:buffer 0 -1
     ```
   - Phải thấy 1 JSON string (event vừa push).

3. **Đợi 1-2 giây:**
   ```redis
   LRANGE chat:unread:buffer 0 -1
   ```
   - Phải trả về `(empty array)` — buffer đã được flush.
   - Server console log: `[Aggregator] flushed 1 events to 1 job`.
   - Worker log: `[Unread Worker] processing 1 events`.

4. **Test gửi nhanh 10 message:**
   - 10 message trong 1 giây.
   - Buffer sẽ có 10 events.
   - Sau 1s, flush thành 1 job với 10 events.
   - Console:
     - `[Aggregator] flushed 10 events to 1 job`
     - `[Unread Worker] processing 10 events`

5. **Test idempotency:**
   - Push cùng event 2 lần (giả lập retry).
   - Worker vẫn chạy OK (xử lý 2 events).

### Checklist

- [ ] `unread.aggregator.ts` đã tạo
- [ ] `startUnreadAggregator` được gọi trong `index.ts`
- [ ] `handleSendMessage` dùng `enqueueUnread` thay `emitUnreadChannel`
- [ ] Test gửi 1 message → buffer có 1 event → sau 1s flush thành 1 job
- [ ] Test gửi 10 message nhanh → 1 job với 10 events
- [ ] Server không bị lỗi

---

## 🐛 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|-----|-------------|----------|
| Buffer tăng vô hạn | Worker crash → không ai consume | Restart worker, check `removeOnComplete` |
| Event mất khi restart | LRANGE xong → server chết → DEL chưa chạy | Buffer chỉ là tạm, không nên là source of truth |
| `JSON.parse` fail | Event không phải JSON | Có try-catch rồi, an toàn |
| Worker xử lý 2 lần cùng event | Race condition LRANGE-DEL | Đảm bảo DEL trước queue.add |
| `connection.lpush is not a function` | Sai import `ioredis` | Check lại import |

### Debug

Thêm log tạm:

```typescript
export const enqueueUnread = async (event) => {
  console.log(`[enqueueUnread] push event:`, event)
  await connection.lpush(...)
  ...
}

// Trong startUnreadAggregator:
console.log(`[Aggregator] LRANGE got ${events.length} events`)
```

Sau khi test, **xoá log**.

---

## 📊 Kết quả Phase 7

| Metric | Trước | Sau |
|--------|-------|-----|
| Job / giây (1000 msg) | 1000 | 1 |
| Worker pickup overhead | 5000ms | 5ms |
| Memory buffer | 0 | ~100KB (tối đa 10K events) |
| Latency end-to-end | 50ms | 1.05s (acceptable) |

**Tiết kiệm 1000x overhead BullMQ.**

---

## ⏭️ Phase tiếp theo

**[Phase 8: Pub/Sub cross-instance notify →](./phase-08-pubsub-notify.md)**

Phase 8 sẽ thêm Pub/Sub channel: sau khi Worker xử lý xong, broadcast tới tất cả Node instance để user nhận `channel_unread` real-time.
