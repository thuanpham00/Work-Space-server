# Phase 6: BullMQ - Queue + Worker

> ⏱️ **Thời gian:** 1 giờ
> 🎯 **Mục tiêu:** Tách phần xử lý nặng (DB write batch, broadcast unread) ra khỏi main flow
> 📍 **Vị trí code:** `src/queues/queue.ts` (mới) + `src/queues/unread.worker.ts` (mới) + `src/index.ts` (sửa)

---

## 🎯 Vấn đề hiện tại

Trong `handleSendMessage` (sau Phase 1-3):

```typescript
async function handleSendMessage(io, data) {
  // 1. Insert message (DB)
  // 2. Insert attachments (DB)
  // 3. localEmit receive_message
  // 4. emitUnreadChannel (cache + Promise.all)
  // 5. ... tất cả chạy tuần tự, blocking
}
```

**Vấn đề:**
- Một hàm làm quá nhiều việc.
- Nếu bước 4 (emit cho 1000 users) chậm → user chờ phản hồi.
- Khi scale: 1000 msg/s × 1000 users = 1 triệu lần emit/s → không scale nổi.

**Giải pháp:** Tách phần "không cần real-time chính xác" ra xử lý sau qua Queue.

---

## 📚 Lý thuyết tối thiểu

### Queue là gì?

```
Main flow:                Queue:                Worker (chạy nền):
- Lưu message             [job1] ←───┐         - Pickup job
- Emit real-time          [job2]      │         - Xử lý
- Đẩy "unread" job       [job3]      │         - Retry nếu fail
  (1ms)                   ...        │
                                      └──── Push job
```

**Main flow** không cần đợi worker. Trả response ngay cho user.

### BullMQ là gì?

Thư viện queue dùng Redis làm storage. Job lưu trong Redis, worker đọc và xử lý.

**Cấu trúc key Redis (BullMQ):**

```
bull:unread-batch:wait      ← List các job chờ
bull:unread-batch:active    ← Set job đang chạy
bull:unread-batch:completed ← Sorted Set job xong
bull:unread-batch:failed    ← Sorted Set job fail
```

### Producer-Consumer

```
Producer: queue.add(name, data)    ← đẩy job vào
Consumer: Worker                   ← chạy liên tục, lấy job ra xử lý
```

### Competing consumers

Nhiều worker cùng consume 1 queue → Redis đảm bảo mỗi job chỉ đi đến 1 worker (atomic).

→ **Horizontal scaling cho worker process.**

### Exponential backoff

```
Failure 1 → wait 1s → retry
Failure 2 → wait 2s → retry
Failure 3 → wait 4s → retry
Failure 4 → DLQ (dead letter queue, manual intervention)
```

**Tại sao cần?** Nếu DB tạm thời quá tải, retry ngay chỉ làm tệ hơn. Đợi vài giây → DB có thời gian recover.

---

## 💻 Bước 1: Cài package

```bash
npm install bullmq
npm install -D @types/bullmq
```

---

## 💻 Bước 2: Tạo file `src/queues/queue.ts`

File này khai báo Queue (Producer).

```typescript
import { Queue } from 'bullmq'
import IORedis from 'ioredis'

// ============ CONNECTION ============
// BullMQ cần 1 connection riêng (không dùng ioredis singleton vì cần config đặc biệt)
const connection = new IORedis(
  process.env.REDIS_URL ?? 'redis://localhost:6379',
  {
    // ⚠️ BẮT BUỘC: BullMQ yêu cầu option này
    // Lý do: BullMQ tự quản lý retry, không để ioredis tự retry
    maxRetriesPerRequest: null
  }
)

// ============ QUEUE DEFINITION ============
export const unreadQueue = new Queue('unread-batch', {
  connection,
  defaultJobOptions: {
    // Retry tối đa 3 lần với exponential backoff
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    
    // Dọn job đã xong (giữ 1000 job gần nhất, xoá cũ hơn)
    removeOnComplete: { count: 1000 },
    
    // Giữ job fail tối đa 5000 (cho debug)
    removeOnFail: { count: 5000 }
  }
})

// Log khi queue có lỗi
unreadQueue.on('error', (err) => {
  console.error('[unreadQueue] error:', err)
})
```

---

## 🔍 Giải thích code

### Tại sao connection riêng, không dùng ioredis singleton?

```typescript
new IORedis(URL, { maxRetriesPerRequest: null })
```

**Giải thích:**
- BullMQ cần `maxRetriesPerRequest: null` để nó tự quản lý retry.
- Nếu dùng singleton (đã có `maxRetries` mặc định 20) → conflict logic.
- Tạo 1 connection riêng cho BullMQ.

### `attempts: 3` + `backoff: exponential`

```typescript
attempts: 3,
backoff: { type: 'exponential', delay: 1000 }
```

**Giải thích:**
- Job fail → retry 3 lần.
- Lần 1 fail → đợi 1s → retry.
- Lần 2 fail → đợi 2s → retry.
- Lần 3 fail → đợi 4s → retry.
- Sau 3 lần → job vào `failed` set (DLQ).

### `removeOnComplete: { count: 1000 }`

```typescript
removeOnComplete: { count: 1000 }
```

**Giải thích:**
- Job thành công → giữ lại 1000 job gần nhất, xoá job cũ.
- Tránh Redis phình vô hạn.
- Có thể set `age: 86400` để xoá job > 1 ngày.

### Tên queue `'unread-batch'`

Queue name = key prefix trong Redis. Mỗi queue nên có tên riêng (vd: `'send-email'`, `'generate-thumbnail'`).

---

## 💻 Bước 3: Tạo Worker `src/queues/unread.worker.ts`

File này định nghĩa Consumer (Worker xử lý job).

```typescript
import { Worker, Job } from 'bullmq'
import IORedis from 'ioredis'

// ============ TYPES ============
export interface UnreadEvent {
  channelId: number
  workspaceId: number
  senderId: number
  messageId: number
  createdAt: string
}

export interface UnreadBatchJob {
  events: UnreadEvent[]
}

// ============ WORKER ============
const startUnreadWorker = () => {
  // Tạo connection riêng cho worker
  const connection = new IORedis(
    process.env.REDIS_URL ?? 'redis://localhost:6379',
    { maxRetriesPerRequest: null }
  )

  // Tạo Worker
  const worker = new Worker<UnreadBatchJob>(
    'unread-batch',  // tên queue (phải khớp với queue.ts)
    
    // Processor function: xử lý job
    async (job: Job<UnreadBatchJob>) => {
      const { events } = job.data
      
      if (events.length === 0) {
        return { processed: 0 }
      }
      
      console.log(`[Unread Worker] processing ${events.length} events`)
      
      // ============ BẮT ĐẦU XỬ LÝ ============
      // (Phase 7 sẽ thay bằng logic thật - broadcast pub/sub)
      // Tạm thời chỉ log
      
      for (const event of events) {
        console.log(`  - channel ${event.channelId} message ${event.messageId}`)
      }
      
      return { processed: events.length }
    },
    
    // Worker options
    {
      connection,
      
      // Số job chạy song song
      concurrency: 5,
      
      // Rate limit: tối đa 10 job mỗi 1 giây
      limiter: {
        max: 10,
        duration: 1000
      }
    }
  )

  // ============ EVENT LOGS ============
  worker.on('completed', (job) => {
    console.log(`[Unread Worker] job ${job.id} completed`)
  })
  
  worker.on('failed', (job, err) => {
    console.error(`[Unread Worker] job ${job?.id} failed:`, err.message)
  })
  
  worker.on('error', (err) => {
    console.error(`[Unread Worker] worker error:`, err)
  })

  return worker
}

export default startUnreadWorker
```

---

## 🔍 Giải thích code

### Tạo Worker

```typescript
new Worker<UnreadBatchJob>(
  'unread-batch',
  async (job) => {
    // xử lý job ở đây
  },
  { connection, concurrency: 5, limiter: {...} }
)
```

**Giải thích:**
- Generic `<UnreadBatchJob>` giúp TypeScript biết kiểu data.
- Tham số thứ 2 là **processor function** — chạy cho mỗi job.
- Tham số thứ 3 là options.

### `concurrency: 5`

```typescript
concurrency: 5
```

**Giải thích:**
- Worker xử lý 5 job cùng lúc.
- Tăng lên nếu job nhẹ (chỉ Redis ops).
- Giảm xuống nếu job nặng (DB query, API call).

### `limiter`

```typescript
limiter: { max: 10, duration: 1000 }
```

**Giải thích:**
- Tối đa 10 job pickup mỗi 1 giây.
- Job dư vào `wait` (không mất).
- Bảo vệ hệ thống khỏi spike (vd: 1000 job đổ về cùng lúc).

### Event listeners

```typescript
worker.on('completed', (job) => {...})
worker.on('failed', (job, err) => {...})
```

**Giải thích:**
- `completed`: job xử lý thành công → log.
- `failed`: job fail → log error. Job vẫn retry theo `attempts`.
- `error`: lỗi ở tầng worker (không phải job) → log để debug.

### Stalled job detection (built-in)

BullMQ tự detect worker crash:
- Job pickup → set "stalled timeout" 30s.
- Worker gọi `job.updateProgress()` → reset timeout.
- Quá timeout → job tự move về `wait` → worker khác pickup.

→ Self-healing, không cần code thêm.

---

## 💻 Bước 4: Khởi động Worker

Mở `src/index.ts`, thêm:

```typescript
import startUnreadWorker from '~/queues/unread.worker'

// ... existing code (server.listen, ...)

// Khởi động worker
if (process.env.NODE_ENV !== 'test') {
  startUnreadWorker()
  console.log('[BullMQ] worker started')
}
```

**Tại sao check `NODE_ENV !== 'test'`?**
- Test thường không cần worker chạy thật.
- Tránh interfere với unit test.

---

## 💻 Bước 5: Test bằng cách push job thử

Tạm thời tạo 1 file test `test-push-job.ts` ở root:

```typescript
import { unreadQueue } from './src/queues/queue'

async function main() {
  // Push 1 job test
  const job = await unreadQueue.add('test', {
    events: [
      {
        channelId: 10,
        workspaceId: 1,
        senderId: 15,
        messageId: 1001,
        createdAt: new Date().toISOString()
      }
    ]
  })
  console.log('Pushed job:', job.id)
  
  // Đợi worker xử lý
  await new Promise(r => setTimeout(r, 2000))
  
  await unreadQueue.close()
  process.exit(0)
}

main().catch(console.error)
```

Chạy:
```bash
npx ts-node test-push-job.ts
```

Kết quả mong đợi trong console:
```
[BullMQ] worker started
[Unread Worker] processing 1 events
  - channel 10 message 1001
[Unread Worker] job 1 completed
```

Sau khi test xong, **xoá file `test-push-job.ts`**.

---

## ✅ Checkpoint Phase 6

### Checklist

- [ ] File `src/queues/queue.ts` đã tạo
- [ ] File `src/queues/unread.worker.ts` đã tạo
- [ ] `src/index.ts` đã gọi `startUnreadWorker()`
- [ ] Server log `[BullMQ] worker started` khi khởi động
- [ ] Test push job thành công, console log `[Unread Worker] processing N events`
- [ ] Trong redis-cli:
  ```bash
  docker exec -it chat-redis redis-cli
  ```
  ```redis
  KEYS bull:unread-batch:*
  ```
  Phải thấy các key BullMQ.

### Test nâng cao

**Test retry:**
- Trong worker, tạm thời throw error:
  ```typescript
  throw new Error('test fail')
  ```
- Push job → job fail → retry 3 lần → vào `failed`.
- Redis: `ZCARD bull:unread-batch:failed` → tăng.

Sau khi verify, **xoá throw** đi.

---

## 🐛 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|-----|-------------|----------|
| `Error: maxRetriesPerRequest must be null` | Quên option | Thêm `{ maxRetriesPerRequest: null }` |
| Worker không pickup job | Queue name không khớp | Check `queue.ts` và `worker.ts` cùng tên |
| Job fail ngay lập tức | Logic processor throw error | Check lại code processor |
| Memory leak | Quên `removeOnComplete` | Thêm option |
| `Cannot find module 'bullmq'` | Chưa cài | `npm install bullmq` |

### Debug checklist

1. `redis-cli MONITOR` xem có traffic không.
2. `KEYS bull:*` xem có key BullMQ không.
3. Console có log worker event không.

---

## 📊 Kết quả Phase 6

| Tính năng | Trước | Sau |
|-----------|-------|-----|
| Main flow latency | ~250ms (chờ tất cả) | ~15ms (chỉ phần critical) |
| Retry khi fail | ❌ Mất data | ✅ Auto retry 3 lần |
| Backpressure | ❌ Tự vỡ | ✅ Rate limit |
| Multi-instance worker | ❌ | ✅ Competing consumers |

**Main flow cải thiện ~17x!**

---

## ⏭️ Phase tiếp theo

**[Phase 7: Aggregator - Buffer trước Queue →](./phase-07-aggregator.md)**

Phase 7 sẽ thêm buffer pattern: gom 100 message trong 1 giây thành 1 job, giảm 100x job count.
