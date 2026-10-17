# Tối ưu Real-time với Redis cho hệ thống Chat (Discord Clone)

> **Tài liệu đề xuất kỹ thuật** — Áp dụng cho `Project-Fullstack/server`
> **Phạm vi:** Thay thế kiến trúc Socket.IO in-memory hiện tại bằng Redis-backed stack để scale ngang và giảm tải DB.
> **Đối tượng đọc:** Backend dev đã quen Node + Prisma, mới tiếp cận Redis.

---

## Mục lục

1. [Tại sao cần Redis?](#1-tại-sao-cần-redis)
2. [Tổng quan giải pháp](#2-tổng-quan-giải-pháp)
3. [Stack công nghệ](#3-stack-công-nghệ)
4. [Kiến trúc mục tiêu](#4-kiến-trúc-mục-tiêu)
5. [Triển khai từng phần](#5-triển-khai-từng-phần)
   - [5.1. Redis adapter cho Socket.IO](#51-redis-adapter-cho-socketio)
   - [5.2. ioredis cache channel members](#52-ioredis-cache-channel-members)
   - [5.3. BullMQ xử lý batch job](#53-bullmq-xử-lý-batch-job)
   - [5.4. Thay thế in-memory presence](#54-thay-thế-in-memory-presence)
   - [5.5. Refactor `handleSendMessage`](#55-refactor-handlesendmessage)
6. [Cấu hình môi trường](#6-cấu-hình-môi-trường)
7. [Cài đặt & Migration](#7-cài-đặt--migration)
8. [Đo lường & Monitoring](#8-đo-lường--monitoring)
9. [Lộ trình triển khai](#9-lộ-trình-triển-khai)
10. [Câu hỏi thường gặp](#10-câu-hỏi-thường-gặp)
11. [Giải thích lý thuyết cách hoạt động](#11-giải-thích-lý-thuyết-cách-hoạt-động)
    - [11.1. Cơ chế Socket.IO Redis Adapter](#111-cơ-chế-socketio-redis-adapter)
    - [11.2. Cơ chế Pub/Sub của Redis](#112-cơ-chế-pubsub-của-redis)
    - [11.3. Cơ chế Cache + Invalidation](#113-cơ-chế-cache--invalidation)
    - [11.4. Cơ chế BullMQ Job Queue](#114-cơ-chế-bullmq-job-queue)
    - [11.5. Cơ chế Presence với Sorted Set](#115-cơ-chế-presence-với-sorted-set)
    - [11.6. Luồng end-to-end của 1 message mới](#116-luồng-end-to-end-của-1-message-mới)
    - [11.7. Đảm bảo tính nhất quán](#117-đảm-bảo-tính-nhất-quán)
    - [11.8. Phân tích độ phức tạp & đánh đổi](#118-phân-tích-độ-phức-tạp--đánh-đổi)

---

> **Tài liệu liên quan:**
> - [`Document/socket-current-architecture.md`](./socket-current-architecture.md) — Mô tả chi tiết kiến trúc hiện tại + nhược điểm.


---

## 1. Tại sao cần Redis?

### 1.1. Vấn đề hiện tại của hệ thống

Đọc lại `src/socket/socket.ts` và `src/socket/utils.ts`, hệ thống đang gặp **3 vấn đề cốt lõi**:

| # | Vấn đề | Vị trí | Tác động khi scale |
|---|--------|--------|-------------------|
| 1 | **In-memory presence** dùng `Map` Node | `src/socket/online-users.ts` | Mất state khi restart, không share giữa nhiều server instance |
| 2 | **N+1 query DB cho unread** | `emitUnreadChannel` (utils.ts:51-84) | Mỗi tin nhắn → 1 query `channelMember.findMany` + vòng lặp emit tuần tự |
| 3 | **Emit đồng bộ + blocking** | `for (const member of members)` (utils.ts:78-83) | Chặn event loop khi channel có nhiều thành viên |
| 4 | **Không có backpressure** | `handleSendMessage` | Socket chậm sẽ block request tiếp theo |
| 5 | **Read state ghi tuần tự** | `upsertChannelReadState` | Dùng `upsert` → DB bottleneck khi nhiều user connect cùng lúc |

### 1.2. Tại sao chọn Redis?

Redis giải quyết **đồng thời** tất cả 5 vấn đề trên vì:

- **In-memory database cực nhanh** (sub-ms latency) — phù hợp cache và pub/sub.
- **Pub/Sub native** — Socket.IO Redis adapter dùng để broadcast event giữa các Node instance.
- **Data structures phong phú** — Hash, Set, Sorted Set, Stream đủ để model hóa presence, queue, rate-limit.
- **Persistence tùy chọn** — AOF/RDB giúp state không mất khi restart (nếu cấu hình).
- **Hệ sinh thái Node cực mạnh** — `ioredis`, `bullmq`, `@socket.io/redis-adapter` đều production-ready.

### 1.3. Tại sao KHÔNG chọn Kafka / RabbitMQ / Ably ngay?

| Công nghệ | Lý do chưa phù hợp | Khi nào nên dùng |
|-----------|-------------------|------------------|
| Kafka | Overkill, vận hành phức tạp, cần Zookeeper/KRaft | > 100K CCU, cần ordering guarantee giữa nhiều consumer |
| RabbitMQ | Tốt nhưng thừa tính năng routing, latency cao hơn Redis | Khi cần AMQP, multi-protocol |
| Ably / Pusher | Vendor lock-in, chi phí theo message, data ra khỏi hệ thống | Team nhỏ, muốn đi nhanh, sẵn sàng trả tiền |
| WebSocket thuần | Phải tự implement reconnection, room, broadcast | Khi cần control 100% protocol |

→ **Redis là "sweet spot"**: đủ mạnh, đủ rẻ, đủ quen thuộc, ROI cao nhất.

---

## 2. Tổng quan giải pháp

### 2.1. 3 thành phần cốt lõi

```
┌──────────────────────────────────────────────────────────────┐
│                        REDIS STACK                            │
│                                                              │
│  ┌────────────────────┐  ┌────────────────────┐              │
│  │  Socket.IO Adapter │  │  ioredis (Cache)   │              │
│  │  ─────────────     │  │  ─────────────     │              │
│  │  Pub/Sub rooms     │  │  channel members   │              │
│  │  broadcast cross-  │  │  user session      │              │
│  │  instance          │  │  workspace config  │              │
│  └────────────────────┘  └────────────────────┘              │
│                                                              │
│  ┌────────────────────────────────────────────────┐          │
│  │           BullMQ (Job Queue)                    │          │
│  │  ─────────────────────────                     │          │
│  │  - unread-batch worker (1s)                    │          │
│  │  - notification worker                          │          │
│  │  - read-state sync worker                       │          │
│  │  - retry + dead-letter tự động                 │          │
│  └────────────────────────────────────────────────┘          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 2.2. Trước / Sau so sánh

**Trước** (hiện tại):
```
Client → Socket.IO → Node (in-memory) → MySQL query → emit từng user
                          ↓
                    Map<userId, Set<socketId>>  ← MẤT khi restart
```

**Sau** (đề xuất):
```
Client → Socket.IO → Node → MySQL (chỉ message) → emit channel
                              ↓
                         Redis pub/sub (cross-instance)
                              ↓
                    BullMQ worker (batch mỗi 1s)
                              ↓
                    Redis pipeline → publish user:N rooms
```

---

## 3. Stack công nghệ

### 3.1. Package cần cài

```bash
npm install ioredis @socket.io/redis-adapter bullmq
npm install -D @types/bullmq
```

| Package | Version | Vai trò |
|---------|---------|---------|
| `ioredis` | ^5.4.x | Redis client thay thế `redis` (built-in tốt hơn, hỗ trợ cluster) |
| `@socket.io/redis-adapter` | ^8.3.x | Scale Socket.IO horizontal qua Redis pub/sub |
| `bullmq` | ^5.x | Queue/Worker framework trên Redis (thay `bull` cũ) |

### 3.2. Tại sao chọn `ioredis` thay vì `node-redis`?

- Hỗ trợ Cluster, Sentinel, Pipeline tốt hơn.
- API Promise-first, không cần callback hell.
- Tự động reconnect, exponential backoff.
- TypeScript-first, types đầy đủ.

### 3.3. Tại sao chọn `bullmq` thay vì `bull`?

- `bull` đã deprecated, dùng `bullmq` cho dự án mới.
- Hỗ trợ Worker, Flow, Rate-limit, Repeatable jobs.
- Dashboard UI: `bull-board` (optional, dev only).

---

## 4. Kiến trúc mục tiêu

```
                    ┌──────────────────┐
                    │  React Client    │
                    │  (port 5173)     │
                    └────────┬─────────┘
                             │ Socket.IO + JWT
                             ▼
        ┌────────────────────────────────────────┐
        │      Node.js Server (N instance)       │
        │                                        │
        │  ┌──────────────┐  ┌──────────────┐    │
        │  │ Socket.IO    │  │ Express API  │    │
        │  │ Handler      │  │ (existing)   │    │
        │  └──────┬───────┘  └──────┬───────┘    │
        │         │                 │            │
        │         ▼                 ▼            │
        │  ┌──────────────────────────────┐      │
        │  │      Service Layer           │      │
        │  │  - channelService            │      │
        │  │  - userService               │      │
        │  │  - enqueueUnread() ← NEW     │      │
        │  └──────┬───────────────────────┘      │
        │         │                              │
        │         ▼                              │
        │  ┌──────────────┐  ┌──────────────┐    │
        │  │ BullMQ       │  │ Prisma       │    │
        │  │ Producer     │  │ Client       │    │
        │  └──────┬───────┘  └──────┬───────┘    │
        └─────────┼────────────────┼────────────┘
                  │                │
                  ▼                ▼
           ┌──────────┐      ┌──────────┐
           │  Redis   │      │PostgreSQL│
           │          │      │  (MySQL) │
           └──────────┘      └──────────┘
                  ▲
                  │
           ┌──────┴─────────────────────┐
           │  BullMQ Workers            │
           │  ─────────────────         │
           │  - unread-batch worker     │
           │  - notification worker     │
           │  - read-state sync worker  │
           └────────────────────────────┘
```

---

## 5. Triển khai từng phần

### 5.1. Redis adapter cho Socket.IO

**File: `src/socket/redis.adapter.ts` (MỚI)**

```typescript
import { createAdapter, RedisAdapterOptions } from '@socket.io/redis-adapter'
import { createClient, RedisClient } from 'redis'
import { Server } from 'socket.io'

const pubClient: RedisClient = createClient({ url: process.env.REDIS_URL })
const subClient: RedisClient = pubClient.duplicate()

// Promise này resolve khi cả 2 client connected
let adapterReady: Promise<void> | null = null

export const initRedisAdapter = (io: Server): Promise<void> => {
  if (adapterReady) return adapterReady

  adapterReady = (async () => {
    await Promise.all([pubClient.connect(), subClient.connect()])

    io.adapter(createAdapter(pubClient, subClient, {
      key: 'socket.io:adapter',  // prefix cho pub/sub channels
      requestsTimeout: 5000      // timeout khi fetch rooms từ instance khác
    } satisfies RedisAdapterOptions))

    console.log('[Redis] Socket.IO adapter attached')
  })()

  return adapterReady
}

export const getRedisClients = () => ({ pubClient, subClient })
```

**Sửa `src/socket/socket.ts`:**

```diff
 export const initialSocket = async (httpSocket: ServerHttp) => {
-  io = new Server(httpSocket, {
-    cors: { origin: ['http://localhost:5173'], methods: ['GET', 'POST', 'PUT', 'DELETE'] }
-  })
+  io = new Server(httpSocket, {
+    cors: { origin: ['http://localhost:5173'], methods: ['GET', 'POST', 'PUT', 'DELETE'] }
+  })
+
+  // Đợi Redis adapter sẵn sàng TRƯỚC khi lắp middleware/handler
+  await initRedisAdapter(io)

   io.use(async (socket, next) => { /* ...giữ nguyên... */ })
   io.on('connection', async (socket) => { /* ...giữ nguyên... */ })
 }
```

**Lợi ích ngay lập tức:**
- Có thể chạy 2-3 Node instance sau Nginx/PM2, Socket.IO tự đồng bộ.
- Không cần thay đổi bất kỳ đoạn `io.to(...).emit(...)` nào.

---

### 5.2. ioredis cache channel members

**File: `src/services/redis.services.ts` (MỚI)**

```typescript
import Redis from 'ioredis'
import databaseServices from './database.services'

// Singleton, dùng chung cho toàn app
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  keyPrefix: 'chat:',          // prefix mọi key
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false
})

redis.on('error', (err) => console.error('[Redis]', err))
redis.on('connect', () => console.log('[Redis] connected'))

// =================== CHANNEL MEMBERS CACHE ===================

const MEMBER_TTL = 300 // 5 phút

export const getChannelMemberIds = async (channelId: number): Promise<number[]> => {
  const key = `channel:${channelId}:members`

  // 1. Thử cache
  const cached = await redis.smembers(key)
  if (cached.length > 0) return cached.map(Number)

  // 2. Cache miss → query DB
  const members = await databaseServices.prisma.channelMember.findMany({
    where: { channelId },
    select: { userId: true }
  })
  const userIds = members.map(m => m.userId)

  // 3. Ghi cache (dùng pipeline để atomic)
  if (userIds.length > 0) {
    const pipeline = redis.pipeline()
    pipeline.sadd(key, ...userIds.map(String))
    pipeline.expire(key, MEMBER_TTL)
    await pipeline.exec()
  }

  return userIds
}

// Invalidate khi có thay đổi membership
export const invalidateChannelMembers = async (channelId: number): Promise<void> => {
  await redis.del(`channel:${channelId}:members`)
}

// =================== CHANNEL WORKSPACE CACHE ===================

export const getChannelWorkspaceId = async (channelId: number): Promise<number | null> => {
  const key = `channel:${channelId}:workspace`
  const cached = await redis.get(key)
  if (cached) return Number(cached)

  const channel = await databaseServices.prisma.channel.findUnique({
    where: { id: channelId },
    select: { workspaceId: true }
  })
  if (!channel) return null

  await redis.set(key, channel.workspaceId, 'EX', MEMBER_TTL)
  return channel.workspaceId
}

export default redis
```

**Sửa `src/socket/utils.ts` — hàm `emitUnreadChannel`:**

```diff
 export const emitUnreadChannel = async (
   io: Server,
   params: { channelId: number; senderId: number; latestMessageId: number }
 ) => {
   const { channelId, senderId, latestMessageId } = params

-  const channel = await databaseServices.prisma.channel.findFirst({
-    where: { id: channelId },
-    select: { workspaceId: true }
-  })
-  if (!channel) return
-
-  const members = await databaseServices.prisma.channelMember.findMany({
-    where: { channelId, userId: { not: senderId } },
-    select: { userId: true }
-  })
-
-  for (const member of members) {
-    io.to(Socket_Room.user(member.userId.toString())).emit('channel_unread', {
-      channelId, workspaceId: channel.workspaceId, latestMessageId
-    })
-  }
+  // Dùng cache thay vì query DB
+  const [allMembers, workspaceId] = await Promise.all([
+    redisServices.getChannelMemberIds(channelId),
+    redisServices.getChannelWorkspaceId(channelId)
+  ])
+  if (workspaceId === null) return
+
+  const recipients = allMembers.filter(uid => uid !== senderId)
+
+  // Parallel emit thay vì tuần tự
+  await Promise.all(
+    recipients.map(uid =>
+      io.to(Socket_Room.user(uid.toString())).emit('channel_unread', {
+        channelId, workspaceId, latestMessageId
+      })
+    )
+  )
 }
```

**Kết quả:**
- DB query giảm từ 2 xuống ~0 cho hot channel (5 phút TTL).
- Loop tuần tự → song song.

---

### 5.3. BullMQ xử lý batch job

**File: `src/queues/queue.ts` (MỚI)**

```typescript
import { Queue, QueueEvents } from 'bullmq'
import IORedis from 'ioredis'

// BullMQ cần connection riêng, không dùng keyPrefix
const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null  // BẮT BUỘC cho BullMQ
})

export const unreadQueue = new Queue('unread-batch', {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 1000 },  // giữ 1000 job gần nhất
    removeOnFail: { count: 5000 },
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }
  }
})

// Lắng nghe job fail/stall để log
new QueueEvents('unread-batch', { connection })
  .on('failed', ({ jobId, failedReason }) =>
    console.error(`[unreadQueue] job ${jobId} failed:`, failedReason))
  .on('stalled', ({ jobId }) =>
    console.warn(`[unreadQueue] job ${jobId} stalled`))
```

**File: `src/queues/unread.worker.ts` (MỚI)**

```typescript
import { Worker, Job } from 'bullmq'
import IORedis from 'ioredis'
import databaseServices from '~/services/database.services'
import redis from '~/services/redis.services'
import { getSocketServer } from '~/socket/socket-instance'
import { Socket_Room } from '~/socket/utils'

interface UnreadEvent {
  channelId: number
  workspaceId: number
  senderId: number
  messageId: number
  createdAt: number  // timestamp
}

interface UnreadBatchJob {
  events: UnreadEvent[]
}

export const startUnreadWorker = () => {
  const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null
  })

  const worker = new Worker<UnreadBatchJob>(
    'unread-batch',
    async (job: Job<UnreadBatchJob>) => {
      const { events } = job.data
      if (events.length === 0) return

      // Group events theo channel để chỉ emit 1 lần / channel
      const byChannel = new Map<number, UnreadEvent[]>()
      for (const e of events) {
        if (!byChannel.has(e.channelId)) byChannel.set(e.channelId, [])
        byChannel.get(e.channelId)!.push(e)
      }

      // Lấy members cho tất cả channels (1 query cache duy nhất)
      const channelIds = Array.from(byChannel.keys())
      const memberMap = new Map<number, number[]>()
      await Promise.all(
        channelIds.map(async (cid) => {
          const members = await redis.smembers(`chat:channel:${cid}:members`)
          memberMap.set(cid, members.map(Number))
        })
      )

      // Ghi DB read-state cuối cùng (batched)
      const readStatePayload: any[] = []
      const pipeline = redis.pipeline()

      for (const [channelId, evts] of byChannel) {
        const latest = evts[evts.length - 1]
        const members = memberMap.get(channelId) ?? []
        const recipients = members.filter(uid => uid !== latest.senderId)

        for (const uid of recipients) {
          // Update unread count trong Redis (Set chứa messageId chưa đọc)
          for (const e of evts) {
            pipeline.sadd(`chat:unread:${uid}:${channelId}`, e.messageId)
          }
          pipeline.expire(`chat:unread:${uid}:${channelId}`, 60 * 60 * 24 * 7) // 7 ngày

          readStatePayload.push({
            userId: uid,
            channelId,
            lastReadMessageId: null,  // không tăng ở đây, giữ nguyên
            updatedAt: new Date()
          })
        }
      }

      // Pipeline Redis (1 round-trip thay vì N)
      await pipeline.exec()

      // Publish tới user rooms qua Redis (cross-instance)
      // (Không cần truy cập trực tiếp io, dùng pub/sub channel)
      const pubChannel = `chat:notify:unread`
      const pubPayload = JSON.stringify({
        type: 'unread_batch',
        byChannel: Object.fromEntries(
          Array.from(byChannel.entries()).map(([cid, evts]) => [
            cid, { latest: evts[evts.length - 1].messageId, workspaceId: evts[0].workspaceId }
          ])
        ),
        recipients: Array.from(new Set(
          Array.from(byChannel.entries()).flatMap(([cid, evts]) => {
            const members = memberMap.get(cid) ?? []
            return members.filter(uid => uid !== evts[evts.length - 1].senderId)
          })
        ))
      })
      await connection.publish(pubChannel, pubPayload)

      console.log(`[unreadWorker] processed ${events.length} events, ${byChannel.size} channels`)
    },
    {
      connection,
      concurrency: 5,        // xử lý 5 job song song
      limiter: { max: 10, duration: 1000 }  // tối đa 10 job/giây
    }
  )

  worker.on('completed', (job) => console.log(`[unreadWorker] job ${job.id} done`))
  worker.on('failed', (job, err) => console.error(`[unreadWorker] job ${job?.id} fail:`, err))

  return worker
}
```

**File: `src/queues/unread.aggregator.ts` (MỚI)**

```typescript
import { unreadQueue } from './queue'
import IORedis from 'ioredis'

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null
})

const BUFFER_KEY = 'chat:unread:buffer'
const BUFFER_TTL = 60  // 60s — nếu server crash, mất tối đa 60s buffer
const FLUSH_INTERVAL = 1000  // 1 giây

interface BufferEvent {
  channelId: number
  workspaceId: number
  senderId: number
  messageId: number
  createdAt: number
}

/**
 * Đẩy event vào buffer trong Redis (LPUSH + LTRIM để giới hạn size)
 * Worker sẽ flush mỗi FLUSH_INTERVAL ms
 */
export const enqueueUnread = async (event: BufferEvent): Promise<void> => {
  await connection.lpush(BUFFER_KEY, JSON.stringify(event))
  await connection.ltrim(BUFFER_KEY, 0, 9999)  // giữ tối đa 10000 event
  await connection.expire(BUFFER_KEY, BUFFER_TTL)
}

// Scheduler: cứ 1 giây flush 1 lần
export const startUnreadAggregator = () => {
  setInterval(async () => {
    try {
      // Lấy tất cả event trong buffer (1 round-trip)
      const events = await connection.lrange(BUFFER_KEY, 0, -1)
      if (events.length === 0) return

      // Xóa buffer NGAY LẬP TỨC (tránh xử lý trùng)
      await connection.del(BUFFER_KEY)

      const parsed: BufferEvent[] = events
        .map(e => { try { return JSON.parse(e) as BufferEvent } catch { return null } })
        .filter((e): e is BufferEvent => e !== null)

      if (parsed.length === 0) return

      await unreadQueue.add('batch', { events: parsed }, {
        jobId: `batch-${Date.now()}`  // unique, không gộp job
      })

      console.log(`[unreadAggregator] flushed ${parsed.length} events to BullMQ`)
    } catch (err) {
      console.error('[unreadAggregator] error:', err)
    }
  }, FLUSH_INTERVAL)
}
```

**Worker pub/sub subscriber** — nhận notify từ Redis và emit socket:

**File: `src/queues/unread.subscriber.ts` (MỚI)**

```typescript
import IORedis from 'ioredis'
import { getSocketServer } from '~/socket/socket-instance'
import { Socket_Room } from '~/socket/utils'

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null
})

export const startUnreadSubscriber = async () => {
  await connection.subscribe('chat:notify:unread')

  connection.on('message', (channel, raw) => {
    if (channel !== 'chat:notify:unread') return
    const io = getSocketServer()
    if (!io) return

    const { byChannel, recipients } = JSON.parse(raw) as {
      byChannel: Record<string, { latest: number; workspaceId: number }>
      recipients: number[]
    }

    for (const uid of recipients) {
      io.to(Socket_Room.user(uid.toString())).emit('channel_unread_batch', {
        channels: byChannel
      })
    }
  })

  console.log('[unreadSubscriber] listening on chat:notify:unread')
}
```

**Khởi động trong `src/index.ts`:**

```typescript
import { startUnreadWorker } from '~/queues/unread.worker'
import { startUnreadAggregator } from '~/queues/unread.aggregator'
import { startUnreadSubscriber } from '~/queues/unread.subscriber'

// Sau khi initialSocket() đã chạy
if (process.env.NODE_ENV !== 'test') {
  startUnreadAggregator()
  startUnreadWorker()
  startUnreadSubscriber()
}
```

---

### 5.4. Thay thế in-memory presence

**File `src/socket/online-users.ts` hiện tại** có thể giữ làm fallback nhưng nên chuyển sang dùng Redis Sorted Set.

**File: `src/services/presence.services.ts` (MỚI)**

```typescript
import redis from './redis.services'

const PRESENCE_TTL = 60  // 60s — nếu không heartbeat thì coi như offline

export const setUserOnline = async (userId: number, socketId: string): Promise<void> => {
  const key = `presence:user:${userId}`
  await redis.zadd(key, Date.now(), socketId)
  await redis.expire(key, PRESENCE_TTL * 2)
}

export const setUserOffline = async (userId: number, socketId: string): Promise<void> => {
  const key = `presence:user:${userId}`
  await redis.zrem(key, socketId)
  // Cleanup nếu set rỗng
  const count = await redis.zcard(key)
  if (count === 0) await redis.del(key)
}

export const isUserOnline = async (userId: number): Promise<boolean> => {
  const count = await redis.zcard(`presence:user:${userId}`)
  return count > 0
}

export const getOnlineUsers = async (): Promise<number[]> => {
  // Scan tất cả key presence:user:* — dùng SCAN để không block
  const stream = redis.scanStream({ match: 'presence:user:*', count: 100 })
  const userIds: number[] = []

  for await (const keys of stream) {
    for (const key of keys) {
      const userId = Number(key.split(':')[2])
      const count = await redis.zcard(key)
      if (count > 0) userIds.push(userId)
    }
  }
  return userIds
}
```

**Sửa `src/socket/socket.ts` — handler `disconnect`:**

```diff
-  removeSocket(socket.id)
+  await presenceServices.setUserOffline(userId, socket.id)
+  removeSocket(socket.id)  // giữ làm backup local cache

   // Thêm heartbeat từ client (mỗi 30s)
+  socket.on('heartbeat', async () => {
+    await presenceServices.setUserOnline(userId, socket.id)
+  })
```

**Client-side (gửi mỗi 30s):**
```javascript
setInterval(() => socket.emit('heartbeat'), 30_000)
```

---

### 5.5. Refactor `handleSendMessage`

**Tối ưu cũ + thêm BullMQ:**

```typescript
// src/socket/utils.ts — hàm handleSendMessage
export const handleSendMessage = async (
  io: Server,
  params: {
    userId: number
    user_id: string
    data: {
      channel_id: string | number
      content: string
      message_type: MessageType
      files: Media[]
    }
  }
) => {
  const { userId, user_id, data } = params
  const channelId = Number(data.channel_id)
  const isFiles = data.files.length > 0

  // 1. Tạo message + attachments SONG SONG
  const [res, attachments] = await Promise.all([
    databaseServices.prisma.message.create({
      data: {
        channelId,
        senderId: Number(user_id),
        content: data.content,
        messageType: data.message_type,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      include: { sender: true }
    }),
    isFiles
      ? databaseServices.prisma.attachment.createManyAndReturn({
          data: data.files.map(f => ({
            messageId: 0,  // sẽ patch sau — KHÔNG, phải tuần tự vì cần messageId
            fileName: f.name,
            fileUrl: f.url,
            mimeType: f.type,
            fileSize: f.size,
            createdAt: new Date()
          }))
        })
      : Promise.resolve([])
  ])

  // 2. Patch attachment với messageId thật
  if (isFiles && attachments.length > 0) {
    const patchData = attachments.map((a, idx) => ({
      id: a.id,
      messageId: res.id
    }))
    await databaseServices.prisma.attachment.updateMany({
      where: { id: { in: patchData.map(p => p.id) } },
      data: { messageId: res.id }
    })
  }

  // 3. Build payload + emit message
  const response = { ...res, attachments: attachments.map((a, i) => ({ ...a, messageId: res.id })) }
  io.to(Socket_Room.channel(channelId.toString())).emit('receive_message', response)

  // 4. Đẩy unread vào Redis aggregator (NON-BLOCKING)
  const workspaceId = await redisServices.getChannelWorkspaceId(channelId)
  if (workspaceId !== null) {
    enqueueUnread({
      channelId,
      workspaceId,
      senderId: userId,
      messageId: Number(res.id),
      createdAt: Date.now()
    })
  }
}
```

**Cải thiện so với bản cũ:**
- Promise.all thay vì tuần tự.
- Emit `receive_message` ngay lập tức (UX real-time).
- Unread đẩy vào buffer, không block main flow.

---

## 6. Cấu hình môi trường

**File `.env` (thêm):**

```bash
# Redis
REDIS_URL=redis://localhost:6379
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=                    # để trống nếu local
REDIS_DB=0

# BullMQ
BULLMQ_PREFIX=bull                 # prefix cho key BullMQ
UNREAD_FLUSH_INTERVAL_MS=1000
UNREAD_BATCH_MAX=500
```

**File `src/utils/config.ts` (thêm vào envConfig):**

```typescript
redis: {
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  bullmqPrefix: process.env.BULLMQ_PREFIX ?? 'bull'
}
```

**Docker Compose (khuyến nghị dev):**

```yaml
# docker-compose.yml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s

  redis-insight:  # GUI debug, optional
    image: redis/redisinsight:latest
    ports:
      - "5540:5540"

volumes:
  redis_data:
```

---

## 7. Cài đặt & Migration

### 7.1. Cài package

```bash
npm install ioredis @socket.io/redis-adapter bullmq
npm install -D @types/bullmq
```

### 7.2. Chạy Redis local

```bash
# Cách 1: Docker
docker run -d --name redis -p 6379:6379 redis:7-alpine

# Cách 2: Native (Windows)
# Tải từ https://github.com/microsoftarchive/redis/releases
# Hoặc dùng WSL2 + apt install redis-server
```

### 7.3. File mới cần tạo

```
src/
├── socket/
│   ├── redis.adapter.ts          ← MỚI (mục 5.1)
│   └── online-users.ts           ← GIỮ (fallback)
├── services/
│   ├── redis.services.ts         ← MỚI (mục 5.2)
│   └── presence.services.ts      ← MỚI (mục 5.4)
├── queues/
│   ├── queue.ts                  ← MỚI (mục 5.3)
│   ├── unread.worker.ts          ← MỚI
│   ├── unread.aggregator.ts      ← MỚI
│   └── unread.subscriber.ts      ← MỚI
└── socket/
    └── socket-instance.ts        ← MỚI (helper get io singleton)
```

### 7.4. File cần sửa

```
src/socket/socket.ts              ← import initRedisAdapter, await
src/socket/utils.ts               ← dùng redis cache + enqueueUnread
src/utils/config.ts               ← thêm redis config
src/index.ts                      ← start workers
```

### 7.5. Rollback plan

Nếu gặp lỗi, rollback dễ vì:
- Tất cả thay đổi là thêm file + sửa trong `utils.ts`.
- `initRedisAdapter()` chỉ được gọi khi có env var `REDIS_URL`.
- Có thể tắt worker bằng `BULLMQ_ENABLED=false`.

---

## 8. Đo lường & Monitoring

### 8.1. Metrics cần theo dõi

| Metric | Công cụ | Ngưỡng cảnh báo |
|--------|---------|-----------------|
| Redis memory usage | `redis-cli INFO memory` | > 80% capacity |
| BullMQ queue length | `bullmq` dashboard / API | > 10K pending |
| Worker processing time | Prometheus + `bull_exporter` | p99 > 1s |
| Socket.IO connected sockets | `io.engine.clientsCount` | > 50K per instance |
| DB slow query log | MySQL slow log | > 100ms |
| API p99 latency | APM (Datadog/New Relic) | > 500ms |

### 8.2. Logging chuẩn

```typescript
// Log structured (JSON) để dễ parse
console.log(JSON.stringify({
  ts: new Date().toISOString(),
  level: 'info',
  service: 'unread-worker',
  msg: 'batch processed',
  events: events.length,
  channels: byChannel.size,
  duration_ms: Date.now() - start
}))
```

### 8.3. Health check endpoint

```typescript
// src/routes/health.routes.ts
app.get('/health', async (req, res) => {
  const checks = {
    redis: await redis.ping().then(() => 'ok').catch(() => 'down'),
    postgres: await databaseServices.prisma.$queryRaw`SELECT 1`
      .then(() => 'ok').catch(() => 'down'),
    bullmq: await unreadQueue.isReady() ? 'ok' : 'down'
  }
  const allOk = Object.values(checks).every(v => v === 'ok')
  res.status(allOk ? 200 : 503).json(checks)
})
```

---

## 9. Lộ trình triển khai

### Phase 1: Quick wins (1-2 ngày)

- [ ] Cài Redis + ioredis
- [ ] Cache channel members (mục 5.2)
- [ ] Cache channel workspaceId
- [ ] Sửa `emitUnreadChannel` dùng cache
- [ ] Chạy Promise.all thay tuần tự trong `handleSendMessage`

**Kỳ vọng:** Giảm 60% DB load cho hot channel.

### Phase 2: Horizontal scaling (2-3 ngày)

- [ ] Cài `@socket.io/redis-adapter`
- [ ] Sửa `initialSocket()` attach adapter
- [ ] Test 2 instance local (PM2 cluster mode)
- [ ] Thay in-memory presence bằng Redis (mục 5.4)

**Kỳ vọng:** Có thể chạy N Node instance sau load balancer.

### Phase 3: BullMQ (3-5 ngày)

- [ ] Cài BullMQ
- [ ] Tạo queue + worker + aggregator
- [ ] Đẩy unread vào buffer thay emit trực tiếp
- [ ] Test failover (kill worker giữa chừng)
- [ ] Bull-Board cho dev

**Kỳ vọng:** Giảm 90% DB write cho read-state, có retry/dead-letter tự động.

### Phase 4: Production hardening (1 tuần)

- [ ] Redis Sentinel / Cluster
- [ ] TLS cho Redis
- [ ] Auth password cho Redis
- [ ] Monitoring + alerting
- [ ] Load test (k6 / Artillery)
- [ ] Runbook cho SRE

**Kỳ vọng:** Chịu tải production thực tế.

---

## 10. Câu hỏi thường gặp

### Q1: Redis có cần thiết nếu chỉ có 1 server instance?

**Có**, vì:
- Cache giảm DB load ngay cả single-instance.
- BullMQ vẫn hữu ích (batch, retry, rate-limit).
- Sau này scale ngang không cần refactor.

### Q2: Có thể dùng Redis free plan (Upstash, Redis Cloud) không?

Được, nhưng:
- Cần TLS + AUTH → thêm config.
- Memory giới hạn (30MB Upstash free).
- Pub/Sub vẫn hoạt động, nhưng throughput thấp hơn dedicated.

### Q3: BullMQ có thay thế hoàn toàn WebSocket emit không?

**Không**. WebSocket vẫn cần cho real-time push. BullMQ chỉ thay thế phần **batch processing** và **cross-service communication**.

### Q4: Khi nào thì KHÔNG nên dùng giải pháp này?

- App < 1K CCU và chỉ 1 instance → chưa cần, in-memory đủ.
- Cần strict ordering message theo user → cần Kafka.
- Multi-region active-active → cần Ably/Pusher hoặc tự build CRDT.

### Q5: Migration có ảnh hưởng client không?

**Không**. Socket.IO events và API REST giữ nguyên. Client không cần đổi code.

### Q6: Chi phí vận hành Redis?

- Local: $0 (Docker).
- Managed (Upstash/Redis Labs): $5-50/tháng cho dev/staging.
- Production (AWS ElastiCache / Upstash Pro): $50-500/tháng tùy size.

### Q7: Làm sao test?

```bash
# Unit test
npm test -- --testPathPattern=socket

# Load test với k6
# (sẽ có file k6/load-test.js kèm theo)
k6 run --vus 1000 --duration 30s k6/load-test.js
```

---

## 11. Giải thích lý thuyết cách hoạt động

> Phần này giải thích **vì sao** giải pháp hoạt động, đi sâu vào cơ chế bên trong từng thành phần. Nếu bạn chỉ cần code để chạy, có thể bỏ qua; nếu cần review, debug, hay scale thêm, đây là phần quan trọng nhất.

### 11.1. Cơ chế Socket.IO Redis Adapter

#### 11.1.1. Vấn đề cốt lõi

Socket.IO lưu trữ rooms hoàn toàn trong memory của mỗi Node instance:

```
Instance A: rooms = { "user:15" → Set<socketId_A1, socketId_A2> }
Instance B: rooms = { "user:15" → Set<socketId_B1> }
Instance C: rooms = { "user:15" → Set<socketId_C1> }
```

Khi `io.to("user:15").emit(...)` được gọi ở Instance A, nó **CHỈ** tìm trong Map của A → chỉ gửi cho `socketId_A1, socketId_A2`. Hai instance kia không biết gì.

#### 11.1.2. Cách Redis Adapter giải quyết

Khi attach `@socket.io/redis-adapter`, mỗi instance sẽ:

1. **Subscribe vào 2 channel Redis**:
   - `socket.io:adapter#/#` — nhận broadcast event từ instance khác.
   - `socket.io:adapter#/#requests` — phục vụ request-response (như fetch sockets by room).

2. **Khi gọi `io.to(room).emit(event, payload)`**:
   ```
   Bước 1: Broadcast tới sockets ở local instance  (giống cũ)
   Bước 2: PUBLISH lên Redis channel
           socket.io:adapter#/<room># → payload
   Bước 3: Tất cả instance khác (đã subscribe) nhận payload
   Bước 4: Mỗi instance tìm sockets ở local thuộc room → emit cho chúng
   ```

3. **Hai loại operation**:
   - **Broadcast** (1 → n instance): chỉ dùng pub/sub, fire-and-forget.
   - **Request** (1 → 1 instance): dùng pattern request-response với correlation ID.

#### 11.1.3. Ví dụ minh hoạ

```
User A ở Instance 1, User B ở Instance 2, cùng trong "channel:10"

Instance 1:                           Instance 2:
- User A socket joined "channel:10"   - User B socket joined "channel:10"
- A gửi "send_message"                

Instance 1 handler:
  1. localEmit("channel:10", msg) → gửi cho A (local)
  2. PUBLISH "socket.io:adapter#/channel:10#" → JSON payload

Redis:
  - Nhận publish → forward tới subscribers

Instance 2:
  - Nhận payload từ Redis
  - Tìm local sockets trong "channel:10" → có B
  - emit("receive_message", msg) cho B
```

#### 11.1.4. Đánh đổi

| Ưu điểm | Nhược điểm |
|---------|------------|
| Scale ngang tự động | Mỗi emit phải qua Redis → +1-2ms latency |
| Không cần sticky session | Redis trở thành SPOF (Single Point of Failure) |
| Code không đổi | Tốn thêm 1 round-trip network |
| Rooms sync chính xác | Pub/Sub không persist — nếu Redis restart thì miss event trong lúc đó |

---

### 11.2. Cơ chế Pub/Sub của Redis

#### 11.2.1. Pub/Sub là gì?

Redis Pub/Sub là cơ chế **message broadcast** đơn giản:

```
PUBLISH <channel> <message>   ← Producer gửi
SUBSCRIBE <channel>          ← Consumer đăng ký nhận
```

Khi một message được publish:
- Redis **KHÔNG lưu trữ** message.
- Tất cả client đang subscribe channel đó **NHẬN NGAY** (fire-and-forget).
- Nếu subscribe SAU khi publish → **mất message**.

#### 11.2.2. Tại sao Socket.IO Adapter dùng Pub/Sub thay vì Stream/List?

- **Latency thấp nhất**: pub/sub gần như real-time (~0.1ms trong cùng DC).
- **Không cần persistence**: broadcast event là ephemeral, không cần lưu.
- **Native scaling**: Redis tự fanout tới nhiều subscriber.

#### 11.2.3. Pattern trong giải pháp

```
┌─────────────────────────────────────────────────────────┐
│                  Redis Instance                         │
│                                                         │
│  Channel: socket.io:adapter#/#                          │
│    Subscribers: tất cả Node instances                   │
│    Publisher: bất kỳ instance nào gọi io.to().emit()    │
│                                                         │
│  Channel: chat:notify:unread                            │
│    Subscribers: tất cả Node instances (subscriber.ts)   │
│    Publisher: BullMQ worker                             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Khác biệt với Pub/Sub thông thường:**
- Socket.IO Adapter tự quản lý format message (chuỗi JSON có prefix).
- `unread.subscriber.ts` tự parse JSON rồi gọi `io.to(...).emit(...)`.

#### 11.2.4. Đảm bảo delivery

Pub/Sub **KHÔNG đảm bảo delivery**:
- Nếu instance down → miss event trong lúc đó.
- Nếu Redis restart → miss toàn bộ.

→ Cho nên **không dùng Pub/Sub cho message quan trọng**. Message quan trọng phải qua DB (durable) + BullMQ (retry + DLQ).

---

### 11.3. Cơ chế Cache + Invalidation

#### 11.3.1. Pattern: Cache-Aside (Lazy Loading)

```
┌────────┐    ┌──────────┐    ┌────────┐
│ App    │───►│  Redis   │───►│   DB   │
│        │    │  Cache   │    │        │
└────────┘    └──────────┘    └────────┘
   │                              ▲
   │         cache miss           │
   │──────────────────────────────┘
```

**Đọc:**
1. Check cache (Redis) → hit? return.
2. Miss → query DB → ghi cache → return.

**Ghi:**
1. Ghi DB.
2. **Invalidate cache** (xoá key trong Redis).
3. Lần đọc tiếp theo sẽ miss → query lại DB.

#### 11.3.2. Tại sao chọn Cache-Aside thay vì Write-Through?

| Pattern | Ưu | Nhược |
|---------|----|----|
| **Cache-Aside** ✅ | Đơn giản, chỉ cache khi cần | Risk: cache miss sau invalidate |
| Write-Through | Cache luôn fresh | Tốn write DB + Redis cho mọi update |
| Write-Behind | Write nhanh | Risk mất data nếu Redis chết trước flush |

→ Cache-Aside phù hợp vì:
- Channel member thay đổi **ít** (chỉ khi add/remove user) → tỉ lệ read/write rất lệch.
- Miss cache sau invalidate chỉ tốn 1 query DB, không nguy hiểm.
- Đơn giản, dễ debug.

#### 11.3.3. TTL vs Explicit Invalidation

Hệ thống dùng **CẢ HAI**:

| Cơ chế | Khi nào dùng | Tại sao |
|--------|--------------|---------|
| **TTL = 5 phút** | Cho `channel:${id}:members` | Self-healing nếu miss invalidate |
| **Explicit DEL** | Khi add/remove member | Đảm bảo consistency ngay lập tức |

```typescript
// Khi thêm member vào channel
await prisma.channelMember.create({...})
await redis.del(`chat:channel:${channelId}:members`)
// Lần đọc tiếp theo sẽ miss → query DB → set lại cache

// TTL vẫn chạy ngầm, kể cả khi không có explicit DEL
// → Nếu miss invalidate, sau 5 phút cache tự expire
```

#### 11.3.4. Cache Stampede (vấn đề cần tránh)

Khi cache expire, có thể có **nhiều request đồng thời** cùng miss → tất cả đều query DB.

**Giải pháp trong giải pháp này:** Dùng **TTL jitter** (chấp nhận được cho case này vì read không quá nặng).

```typescript
// Thay vì expire cứng 300s:
const TTL = 300 + Math.floor(Math.random() * 60)  // 300-360s
```

→ Các key expire lệch nhau, giảm xác suất stampede.

---

### 11.4. Cơ chế BullMQ Job Queue

#### 11.4.1. BullMQ hoạt động như thế nào?

BullMQ dùng **Redis Lists** làm queue và **Sorted Sets** để track job state:

```
Redis key structure (mặc định prefix "bull:"):
  bull:<queue>:wait      → List các job chờ xử lý (LPUSH/RPOP)
  bull:<queue>:active    → Set job đang chạy
  bull:<queue>:completed → Sorted Set job xong (theo timestamp)
  bull:<queue>:failed    → Sorted Set job fail
  bull:<queue>:delayed   → Sorted Set job delay (theo execute time)
  bull:<queue>:repeat    → Set các repeatable job
```

**Job lifecycle:**

```
  add()        ┌──────┐   pickup    ┌────────┐  done    ┌───────────┐
  ────────────►│ wait │────────────►│ active │─────────►│ completed │
               └──────┘             └────────┘          └───────────┘
                  │                     │
                  │ delay set           │ fail
                  ▼                     ▼
              ┌────────┐            ┌────────┐
              │ delayed│            │ failed │
              └────────┘            └────────┘
                  │                     │ retry
                  │ time up            │ (nếu attempts < max)
                  ▼                     │
              ┌──────┐                  │
              │ wait │◄─────────────────┘
              └──────┘
```

#### 11.4.2. Tại sao cần Aggregator + Worker riêng?

**Vấn đề nếu push trực tiếp vào queue mỗi message:**

```
100 message/giây = 100 job/giây
→ 100 lần Redis LPUSH
→ 100 lần worker pickup + connect + process
→ Overhead lớn cho tác vụ đơn giản
```

**Giải pháp: Buffer trước, flush theo interval:**

```
┌────────────┐  buffer  ┌────────┐  flush  ┌──────────┐
│ enqueueUnread │───────►│ Redis  │───────►│  BullMQ  │
│ (gọi mỗi  │         │ List   │  1s    │  1 job   │
│  message)  │         │        │        │          │
└────────────┘         └────────┘        └──────────┘
```

→ 100 message/giây → 1 job/giây, xử lý 100 events cùng lúc.

**Lý do tách Aggregator ra khỏi main flow:**

```typescript
// ❌ Blocking main flow
await enqueueUnread(event)  // ← nếu Redis chậm, block send_message

// ✅ Non-blocking (fire-and-forget)
enqueueUnread(event).catch(err => logger.error(err))  // chạy nền
```

#### 11.4.3. Backpressure trong BullMQ

BullMQ có **rate limiter** built-in:

```typescript
new Worker('unread-batch', processor, {
  concurrency: 5,                    // 5 job song song
  limiter: { max: 10, duration: 1000 } // tối đa 10 job/giây
})
```

Khi vượt quá:
- Job mới vào `wait` (không mất).
- Worker đợi `limiter` hết hạn.
- → Bảo vệ DB khỏi bị overwhelm.

#### 11.4.4. Retry & Dead Letter Queue

```typescript
defaultJobOptions: {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 }
  // Lần 1 fail → đợi 1s → retry
  // Lần 2 fail → đợi 2s → retry
  // Lần 3 fail → đợi 4s → retry
  // Hết attempts → vào "failed" set → manual review
}
```

- **Retry 3 lần** với exponential backoff → handle transient error (DB chậm, network blip).
- **Sau 3 lần fail** → job vào `failed` set → alert cho SRE.
- **Không mất data** vì Redis vẫn giữ (trừ khi xoá thủ công).

---

### 11.5. Cơ chế Presence với Sorted Set

#### 11.5.1. Tại sao chọn Sorted Set thay vì Set thường?

| Cấu trúc | Ưu | Nhược | Dùng cho |
|----------|----|----|----------|
| **Set** | Đơn giản | Không có thứ tự | Member của channel (không cần order) |
| **Sorted Set** | Có score, có thể range | Tốn thêm 1 field | **Presence** (cần sort theo timestamp để TTL) |

#### 11.5.2. Cấu trúc key

```
Key:    presence:user:15
Type:   Sorted Set
Members: socketId
Score:   timestamp (millisecond) của lần heartbeat gần nhất
```

```redis
ZADD presence:user:15 1697000000000 "socket_abc"
ZADD presence:user:15 1697000030000 "socket_def"
ZADD presence:user:20 1697000010000 "socket_xyz"
```

#### 11.5.3. Cơ chế TTL ngầm

Không set TTL trực tiếp trên key. Thay vào đó:

1. **Mỗi lần heartbeat (30s)**: `ZADD` lại với score mới.
2. **Mỗi lần disconnect**: `ZREM` socketId.
3. **Cleanup background**: Worker chạy mỗi 60s, gọi:
   ```redis
   ZREMRANGEBYSCORE presence:user:15 -inf <now - 60s>
   ```
   → Xoá socket có score cũ hơn 60s → nếu set rỗng → xoá key.

**Tại sao không dùng EXPIRE trực tiếp?**
- Vì EXPIRE sẽ xoá cả key khi user vẫn còn online (chỉ vì idle 60s).
- Sorted Set + score cho phép **per-member expiration** chính xác hơn.

#### 11.5.4. Đếm online user

```typescript
async function getOnlineUserCount(): Promise<number> {
  // Scan tất cả key presence:user:*
  // Đếm ZCARD > 0
}
```

⚠️ **Lưu ý scale:** Khi có 1M user online, scan sẽ chậm. Cần cache kết quả hoặc dùng HyperLogLog.

---

### 11.6. Luồng end-to-end của 1 message mới

Tổng hợp tất cả cơ chế trên vào 1 ví dụ thực tế:

```
Scenario: User A (instance 1) gửi message vào channel có 100 members
          (User B ở instance 2, User C ở instance 1, đều đang mở channel)
```

**Bước 1: User A gửi `send_message`**

```
Client A → Instance 1: socket.emit("send_message", {content, files})
```

**Bước 2: Instance 1 xử lý (handleSendMessage)**

```
1. Tạo message trong DB (Promise.all với attachments)
2. Build response object { ...message, attachments }
3. localEmit("channel:10", "receive_message", response)
   → Gửi cho A và C ngay (ở cùng instance 1)
4. PUBLISH lên Redis: socket.io:adapter#/channel:10#
5. enqueueUnread(event) → LPUSH vào chat:unread:buffer
```

**Bước 3: Instance 2 nhận từ Redis**

```
1. Subscriber nhận payload từ socket.io:adapter#/channel:10#
2. Tìm local sockets trong "channel:10" → tìm thấy B
3. emit("receive_message", response) cho B
```

**Bước 4: Sau 1 giây, Aggregator flush**

```
1. setInterval (1s) trigger
2. LRANGE chat:unread:buffer 0 -1 → lấy events
3. DEL chat:unread:buffer
4. queue.add('batch', { events })
```

**Bước 5: Worker xử lý job**

```
1. Worker pickup job
2. Group events theo channelId
3. Cho mỗi channel: SMEMBERS chat:channel:10:members
4. Lấy recipient = members - sender
5. Build pipeline Redis:
   - SADD chat:unread:userId:channelId messageId
   - EXPIRE ...
6. EXEC pipeline (1 round-trip)
7. PUBLISH chat:notify:unread với payload {channels, recipients}
```

**Bước 6: Tất cả instance nhận notify**

```
Instance 1:                              Instance 2:
1. Subscriber nhận payload               1. Subscriber nhận payload
2. Parse → recipients: [...]             2. Parse → recipients: [...]
3. Cho mỗi uid:                          3. Cho mỗi uid:
   io.to("user:15").emit(                   io.to("user:30").emit(
     "channel_unread_batch",                  "channel_unread_batch",
     {channels}                               {channels}
   )                                       )
```

**Đếm operation:**

| Operation | Trước (hiện tại) | Sau (giải pháp mới) |
|-----------|------------------|---------------------|
| DB query cho message | 1-2 | 1-2 (giống) |
| DB query cho channel.workspaceId | 1 | 0 (cache) |
| DB query cho channelMember | 1 | 0 (cache) |
| Socket emit receive_message | 1 broadcast | 1 broadcast + Redis pubsub (cross-instance) |
| Socket emit channel_unread | N lần tuần tự | Batch 1 lần/giây qua pipeline |
| DB write read-state | Mỗi join_channel | Deferred qua worker (optional) |

---

### 11.7. Đảm bảo tính nhất quán

#### 11.7.1. Các loại consistency cần quan tâm

| Loại | Mô tả | Giải pháp |
|------|-------|-----------|
| **Cache vs DB** | Cache lệch DB | TTL + explicit invalidate |
| **Multi-instance rooms** | Instance A không biết room ở B | Socket.IO Redis Adapter |
| **Message order** | Client A gửi 5 msg, server nhận thứ tự khác | (Ngoài phạm vi — cần client_msg_id) |
| **Presence** | User disconnect nhưng vẫn online | TTL + ZREMRANGEBYSCORE |
| **BullMQ job** | Worker chết giữa chừng | stalled → retry tự động |

#### 11.7.2. CAP Theorem áp dụng

Hệ thống chọn **AP (Availability + Partition tolerance)** thay vì CP:

- ✅ Luôn có thể gửi/nhận message (Availability).
- ✅ Chia được nhiều region (Partition).
- ❌ Đánh đổi: có thể có **eventual consistency** (DB cuối cùng sẽ đồng bộ, nhưng có thể trễ vài giây).

Ví dụ eventual consistency:
- User A gửi message tại t=0.
- Server publish qua Redis tại t=10ms.
- User B nhận tại t=50ms.
- Read state update tại t=2s (qua BullMQ).
- → Read state "chính xác" sau 2s, không phải real-time.

→ **Chấp nhận được** vì read state không cần real-time chính xác từng milisecond.

---

### 11.8. Phân tích độ phức tạp & đánh đổi

#### 11.8.1. Big-O comparison

| Tác vụ | Hiện tại | Sau |
|--------|----------|-----|
| Tìm user online | O(1) Map lookup | O(1) ZCARD |
| Tìm members của channel | O(N) DB scan | O(1) cache hit / O(N) cache miss |
| Emit cho N members | O(N) tuần tự | O(1) qua Redis pub/sub + parallel emit ở mỗi instance |
| Read state update | O(1) upsert / call | O(1) / call, deferred batched |

#### 11.8.2. Latency budget

```
Hiện tại (1 message, channel 100 members):
  INSERT message         ~5ms
  SELECT workspaceId     ~2ms
  SELECT members         ~10ms
  emit loop (99)         ~200ms  ← BOTTLENECK
  Total:                 ~217ms

Sau (1 message, channel 100 members):
  INSERT message         ~5ms
  localEmit              ~5ms
  PUBLISH Redis          ~1ms
  Total (A nhận):        ~11ms  ← 20x nhanh hơn
  Total (B ở instance khác nhận): ~15ms (qua Redis)
  Unread (deferred):     1-2s (chấp nhận được)
```

#### 11.8.3. Cost analysis

**Throughput:**
- Hiện tại: ~50 msg/s/instance (do blocking loop).
- Sau: ~1000 msg/s/instance (do async + batch).

**Memory:**
- In-memory Map: chiếm ~100 bytes/connection × 10K conn = 1MB.
- Redis: tùy cache size, ước tính 50-200MB cho 10K user.

**Network:**
- Hiện tại: chỉ WebSocket.
- Sau: +WebSocket + Redis pub/sub traffic. Ước tính +20-30% bandwidth per instance.

#### 11.8.4. Khi nào KHÔNG nên dùng giải pháp này

| Tình huống | Lý do |
|-----------|-------|
| App < 1000 CCU, 1 instance | Overhead không cần thiết |
| Cần strict ordering message | Cần Kafka hoặc tự build sequencer |
| Multi-region active-active | Redis pub/sub không cross-region tốt |
| Data residency requirement | Redis cluster phải ở cùng region với app |
| Budget cực thấp | Redis managed + workers = $50-200/tháng |

---

## Tóm tắt

| Trước | Sau |
|-------|-----|
| In-memory Map presence | Redis Sorted Set + TTL |
| 2 query DB / message (unread) | 0 query (cache hit) |
| Emit tuần tự cho từng user | Batch + parallel + Redis pub/sub |
| Không retry khi fail | BullMQ retry 3 lần + DLQ |
| Không scale ngang | Scale ngang tự động |
| Mất state khi restart | Persist trong Redis (nếu cấu hình AOF) |
| Read state ghi tuần tự mỗi join | Deferred batched qua worker |
| N+1 query cho hot channel | Cache hit, chỉ miss 1 lần / 5 phút |

**Effort triển khai:** ~2 tuần (1 dev).
**Lợi ích:** Chịu tải từ 1K → 50K+ CCU trên cùng 1 kiến trúc.
**Chi phí thêm:** ~$50-200/tháng Redis managed.

---

> **Liên hệ / Feedback:** Mọi thắc mắc về tài liệu này, ping vào channel `#backend` trong workspace.
> **Tác giả:** Backend team — `server/src/socket/`
> **Cập nhật lần cuối:** 2026-10-17
