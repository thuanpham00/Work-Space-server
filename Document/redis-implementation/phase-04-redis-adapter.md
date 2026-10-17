# Phase 4: Redis adapter cho Socket.IO

> ⏱️ **Thời gian:** 30 phút
> 🎯 **Mục tiêu:** Scale được 2+ Node instance cùng lúc, cross-instance message hoạt động
> 📍 **Vị trí code:** `src/socket/redis.adapter.ts` (mới) + `src/socket/socket.ts` (sửa)

---

## 🎯 Vấn đề hiện tại

Socket.IO lưu room membership trong memory của **mỗi instance**:

```
Instance A (port 3001):
  rooms = { "user:15" → Set<socket_A1> }
  rooms = { "user:20" → Set<socket_A2> }

Instance B (port 3002):
  rooms = { "user:15" → Set<socket_B1> }
  rooms = { "user:20" → Set<socket_B2> }
```

Khi `io.to("user:20").emit(...)` được gọi ở Instance A:
- Tìm trong Map của A → tìm thấy `socket_A2`.
- Emit cho `socket_A2`.
- **`socket_B2` KHÔNG nhận được** → BUG.

**Triệu chứng khi deploy multi-instance:**
- User ở instance A gửi message.
- User ở instance B không nhận real-time.
- Unread notification biến mất.
- "Mất message" bug rất khó debug.

---

## 📚 Lý thuyết tối thiểu

### Socket.IO Redis Adapter

Thay vì mỗi instance tự quản lý rooms, gắn thêm 1 lớp **Redis Pub/Sub** để đồng bộ.

```
┌──────────────┐         ┌──────────────┐
│  Instance A  │         │  Instance B  │
│              │         │              │
│  Local Map   │         │  Local Map   │
│  "user:15"   │         │  "user:20"   │
│   → socket_A │         │   → socket_B │
└──────┬───────┘         └──────┬───────┘
       │                        │
       │ PUBLISH  ─────────►    │
       │   "user:20"            │
       │                        │
       │         ◄───────── SUBSCRIBE
       ▼                        ▼
   ┌────────────────────────────────┐
   │         Redis                  │
   │   socket.io:adapter#/...       │
   │   (pub/sub channel)            │
   └────────────────────────────────┘
```

**Flow khi `io.to("user:20").emit("hi")` ở Instance A:**

1. Tìm socket "user:20" ở Instance A (local) → không có.
2. PUBLISH lên Redis channel `socket.io:adapter#/user:20#` với payload.
3. Redis broadcast payload tới tất cả subscribers.
4. Instance B nhận payload.
5. Instance B tìm socket "user:20" ở local → tìm thấy `socket_B`!
6. Instance B emit cho `socket_B`.

### Tại sao cần 2 Redis client?

Redis yêu cầu: 1 connection publish, 1 connection subscribe. Một connection không thể làm cả 2 cùng lúc.

```typescript
const pubClient = createClient(...)  // chỉ publish
const subClient = pubClient.duplicate()  // copy cho subscribe
```

---

## 💻 Bước 1: Cài package

```bash
npm install @socket.io/redis-adapter redis
```

**Lưu ý:** Cài thêm package `redis` (không phải `ioredis` đã cài ở Phase 0). `@socket.io/redis-adapter` mặc định dùng package `redis` chính thức.

---

## 💻 Bước 2: Tạo file `src/socket/redis.adapter.ts`

```typescript
import { createAdapter } from '@socket.io/redis-adapter'
import { createClient } from 'redis'
import type { Server } from 'socket.io'

// ============ 2 REDIS CLIENTS ============
// Redis yêu cầu: 1 connection publish, 1 connection subscribe
const pubClient = createClient({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379'
})
const subClient = pubClient.duplicate()

// Cache adapter init promise để không init 2 lần
let adapterReady: Promise<void> | null = null

/**
 * Gắn Redis adapter vào Socket.IO server.
 * Gọi 1 lần khi khởi động.
 * 
 * Hàm này await cho tới khi:
 * 1. Cả 2 client Redis connected
 * 2. Adapter đã gắn vào io server
 */
export const initRedisAdapter = async (io: Server): Promise<void> => {
  if (adapterReady) return adapterReady

  adapterReady = (async () => {
    try {
      await Promise.all([pubClient.connect(), subClient.connect()])
      io.adapter(createAdapter(pubClient, subClient))
      console.log('[RedisAdapter] attached')
    } catch (err) {
      console.error('[RedisAdapter] init error:', err)
      throw err
    }
  })()

  return adapterReady
}
```

---

## 🔍 Giải thích code

### Tại sao `pubClient.duplicate()`?

```typescript
const pubClient = createClient({...})
const subClient = pubClient.duplicate()
```

**Giải thích:**
- Sau khi `subscribe`, connection đó **bị block** — chỉ nhận message, không thể gọi command khác.
- Nên cần 1 connection khác để publish.
- `.duplicate()` tạo 1 connection mới với cùng config.

### Pattern: `adapterReady` promise

```typescript
let adapterReady: Promise<void> | null = null

export const initRedisAdapter = async (io: Server): Promise<void> => {
  if (adapterReady) return adapterReady
  adapterReady = (async () => {...})()
  return adapterReady
}
```

**Giải thích:**
- Nếu gọi `initRedisAdapter` 2 lần, lần thứ 2 trả về promise cũ.
- Đảm bảo chỉ init 1 lần, tránh attach adapter 2 lần.
- Nếu init lần 1 fail → lần 2 sẽ retry (vì `adapterReady` vẫn là promise cũ đã reject).

### `io.adapter(createAdapter(...))`

```typescript
io.adapter(createAdapter(pubClient, subClient))
```

**Giải thích:**
- Mặc định Socket.IO có adapter là `InMemoryAdapter`.
- `createAdapter` từ `@socket.io/redis-adapter` trả về adapter mới dùng Redis.
- `io.adapter()` thay adapter cũ bằng adapter mới.
- Sau dòng này, mọi `io.to(...).emit(...)` đều đi qua Redis.

---

## 💻 Bước 3: Sửa `src/socket/socket.ts`

Mở file `socket.ts`. Tìm phần khởi tạo `io`:

**Trước:**

```typescript
io = new Server(httpSocket, {
  cors: {
    origin: ['http://localhost:5173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
})

io.use(async (socket, next) => {...})
io.on('connection', async (socket) => {...})
```

**Sau:**

```typescript
import { initRedisAdapter } from './redis.adapter'

io = new Server(httpSocket, {
  cors: {
    origin: ['http://localhost:5173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
})

// Phải đợi adapter sẵn sàng TRƯỚC khi bắt đầu nhận connection
await initRedisAdapter(io)

io.use(async (socket, next) => {...})
io.on('connection', async (socket) => {...})
```

**Tại sao `await` quan trọng?**

Nếu không await:
- Server bắt đầu nhận connection.
- Adapter chưa sẵn sàng → emit cross-instance sẽ fail trong vài ms đầu.
- Có thể gây bug ngẫu nhiên.

---

## 💻 Bước 4: Test với 2 instance

### Cấu hình PORT

Mở file `src/utils/config.ts` (hoặc `src/index.ts`). Đảm bảo server đọc PORT từ env:

```typescript
const PORT = process.env.PORT || 3000
```

### Khởi động 2 instance

Mở **2 terminal** riêng biệt:

**Terminal 1:**
```bash
PORT=3001 npm run dev
```

**Terminal 2:**
```bash
PORT=3002 npm run dev
```

Cả 2 phải log `[RedisAdapter] attached`.

### Test client

Cập nhật client React để có thể connect tới cả 2 port (hoặc dùng Nginx):

**Cách đơn giản nhất:** Trong file config client, cho phép chọn port:

```javascript
const SERVER_URL = `http://localhost:${Math.random() > 0.5 ? 3001 : 3002}`
```

Mở 2 tab browser:
- Tab 1: connect tới port 3001, login user A.
- Tab 2: connect tới port 3002, login user B.

Gửi message từ user A → user B phải nhận real-time.

### Verify

Trong cả 2 terminal server, khi user A gửi message, terminal nào cũng phải log emit (do adapter broadcast cho tất cả instance).

---

## ✅ Checkpoint Phase 4

### Checklist

- [ ] Cả 2 instance log `[RedisAdapter] attached` khi khởi động
- [ ] Test cross-instance: message từ A (instance 1) sang B (instance 2) hoạt động
- [ ] Test trong cùng instance: vẫn hoạt động như cũ
- [ ] `redis-cli MONITOR` thấy traffic pub/sub khi có message

### Test nâng cao với redis-cli

```bash
docker exec -it chat-redis redis-cli MONITOR
```

Gửi 1 message. Bạn sẽ thấy:
- `PUBLISH socket.io:adapter#/channel:10# ...`
- `PUBLISH socket.io:adapter#/user:20# ...`

→ Adapter đang hoạt động đúng.

### Cảnh báo

Sau Phase 4, hệ thống có thể scale 2+ instance. **NHƯNG:**
- In-memory presence (`online-users.ts`) vẫn chưa sync giữa các instance.
- Nếu restart 1 instance, presence của users ở instance đó bị mất.
- → Phase 5 sẽ xử lý.

---

## 🐛 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|-----|-------------|----------|
| `RedisAdapter] attached` không log | Redis chưa chạy | `docker start chat-redis` |
| Cross-instance vẫn không hoạt động | Quên `await initRedisAdapter` | Check lại `socket.ts` |
| `Cannot find module '@socket.io/redis-adapter'` | Chưa cài | `npm install @socket.io/redis-adapter redis` |
| `RedisAdapter] init error: connect ECONNREFUSED` | Redis URL sai | Check `.env` |
| 2 instance log duplicate event | Đây là behavior bình thường | Không cần fix |

### Test thêm: Sticky session vẫn hoạt động?

Nếu bạn dùng load balancer với sticky session (cùng IP → cùng instance):
- Cross-instance broadcast vẫn hoạt động (nhờ Redis).
- Sticky session chỉ là tối ưu, không bắt buộc.

---

## 📊 Kết quả Phase 4

| Tính năng | Trước | Sau |
|-----------|-------|-----|
| Scale ngang | ❌ | ✅ |
| Cross-instance message | ❌ Mất | ✅ Qua Redis pub/sub |
| Restart 1 instance | Down cho users ở instance đó | Di chuyển sang instance khác |
| Latency thêm | 0 | +1-2ms (qua Redis) |

---

## ⏭️ Phase tiếp theo

**[Phase 5: Presence với Sorted Set →](./phase-05-presence-sorted-set.md)**

Phase 5 sẽ thay `Map` in-memory bằng Redis Sorted Set, giúp presence restart-safe.
