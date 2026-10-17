# Phase 5: Presence với Sorted Set

> ⏱️ **Thời gian:** 30 phút
> 🎯 **Mục tiêu:** Thay `Map` in-memory bằng Redis Sorted Set, restart không mất state
> 📍 **Vị trí code:** `src/services/presence.services.ts` (mới) + `src/socket/socket.ts` (sửa)

---

## 🎯 Vấn đề hiện tại

Mở file `src/socket/online-users.ts`:

```typescript
const userSockets = new Map<UserId, Set<SocketId>>()
const socketToUser = new Map<SocketId, UserId>()
```

**Vấn đề:**
1. **Restart mất state**: Deploy code → process chết → Map biến mất → user phải reconnect, mời tạm thời hiện offline.
2. **Multi-instance không sync**: Instance A có user 15, instance B không biết. Khi emit `presence_update`, chỉ instance A emit được.

Triệu chứng user thấy: "Bạn tôi cứ chớp online/offline liên tục" hoặc "Sau khi deploy, mọi người mất tick xanh".

---

## 📚 Lý thuyết tối thiểu

### Tại sao Sorted Set, không phải Set thường?

**Set thường:**
```
SADD presence:user:15 "socket_abc"
SMEMBERS presence:user:15 → ["socket_abc"]
```
❌ Không biết socket nào "cũ" (idle) → không thể TTL per-member.

**Sorted Set:**
```
ZADD presence:user:15 1697000000 "socket_abc"   ← score = timestamp
ZADD presence:user:15 1697000030 "socket_def"   ← score = timestamp mới hơn
ZRANGE presence:user:15 0 -1 → ["socket_abc", "socket_def"]
ZSCORE presence:user:15 "socket_abc" → "1697000000"
```
✅ Mỗi member có **score** (timestamp) → biết được "lần cuối heartbeat" → TTL per-member.

### Pattern heartbeat

```
Client gửi "heartbeat" mỗi 30s
  → Server: ZADD lại với score mới

Worker cleanup mỗi 60s:
  → ZREMRANGEBYSCORE xoá members có score cũ
  → Nếu set rỗng → DEL key
```

### Cấu trúc key

```
Key:    chat:presence:user:15
Type:   Sorted Set
Members: socketId
Score:   Date.now() (millisecond)
```

### Cleanup pattern

```redis
# Xoá members có score < (now - 60s)
ZREMRANGEBYSCORE presence:user:15 -inf <timestamp_threshold>

# Check còn members không
ZCARD presence:user:15
# Nếu 0 → DEL key
```

### Tại sao không dùng EXPIRE trực tiếp?

EXPIRE hoạt động trên **key**, không trên member. Nếu set EXPIRE 60s cho key `presence:user:15`:
- User heartbeat liên tục → score update liên tục → nhưng EXPIRE không tự reset khi ZADD.
- → Key bị xoá khi user vẫn còn online.
- → Phải dùng Sorted Set với score để tự quản lý TTL per-member.

---

## 💻 Bước 1: Tạo file `src/services/presence.services.ts`

```typescript
import redis from './redis.services'

const PRESENCE_TTL = 60  // 60 giây - nếu không heartbeat thì coi offline

// ============ USER ONLINE/OFFLINE ============

/**
 * Đánh dấu user online (gọi khi connect + mỗi heartbeat).
 * 
 * - ZADD với score = timestamp
 * - EXPIRE để tự xoá key nếu user offline thật (không phải idle)
 */
export const setUserOnline = async (
  userId: number,
  socketId: string
): Promise<void> => {
  const key = `presence:user:${userId}`
  await redis.zadd(key, Date.now(), socketId)
  // Set TTL cho key = 2x PRESENCE_TTL (cleanup nếu user offline hoàn toàn)
  await redis.expire(key, PRESENCE_TTL * 2)
}

/**
 * Đánh dấu 1 socket offline (gọi khi disconnect).
 * 
 * - ZREM socketId
 * - Nếu set rỗng → DEL key (tiết kiệm memory)
 */
export const setUserOffline = async (
  userId: number,
  socketId: string
): Promise<void> => {
  const key = `presence:user:${userId}`
  await redis.zrem(key, socketId)
  
  // Cleanup key nếu rỗng
  const count = await redis.zcard(key)
  if (count === 0) {
    await redis.del(key)
  }
}

/**
 * Kiểm tra user có online không (còn socket nào active không).
 */
export const isUserOnline = async (userId: number): Promise<boolean> => {
  const count = await redis.zcard(`presence:user:${userId}`)
  return count > 0
}

/**
 * Lấy tất cả userId đang online (scan tất cả key).
 * ⚠️ Chỉ dùng cho admin/debug, KHÔNG dùng trong hot path.
 */
export const getOnlineUserIds = async (): Promise<number[]> => {
  const stream = redis.scanStream({
    match: `${redis.options.keyPrefix}presence:user:*`
  })
  // Lưu ý: scanStream trả key đã có prefix, cần loại bỏ
  // ...

  return []  // TODO: implement nếu cần
}
```

---

## 🔍 Giải thích code

### Hàm `setUserOnline`

```typescript
await redis.zadd(key, Date.now(), socketId)
```

**Giải thích:**
- `ZADD key score member` — thêm member với score.
- `Date.now()` — millisecond hiện tại.
- Nếu member (socketId) đã tồn tại → cập nhật score mới (idempotent).

```typescript
await redis.expire(key, PRESENCE_TTL * 2)
```

**Giải thích:**
- Set TTL 120s cho key.
- Nếu user thực sự offline (không heartbeat, không disconnect) → key tự xoá sau 120s.
- Phòng trường hợp client crash mà không gửi disconnect event.

### Hàm `setUserOffline`

```typescript
const count = await redis.zcard(key)
if (count === 0) {
  await redis.del(key)
}
```

**Giải thích:**
- `ZCARD` đếm số member trong sorted set.
- Nếu user đóng 1 trong nhiều tab → 1 socket bị xoá, vẫn còn socket khác.
- Nếu đóng hết tab → set rỗng → xoá key để Redis không giữ key rỗng.

### Tại sao `keyPrefix` không tự áp dụng cho `scanStream`?

Một số method không tự áp dụng prefix. Bạn cần tự thêm. Hiện tại chưa dùng nên bỏ qua, chỉ implement nếu cần.

---

## 💻 Bước 2: Sửa `src/socket/socket.ts`

Mở file `socket.ts`. Tìm handler `io.on('connection')` và `socket.on('disconnect')`.

**Import thêm:**

```typescript
import { setUserOnline, setUserOffline } from '~/services/presence.services'
```

**Trong `io.on('connection')` — thêm đoạn setUserOnline:**

```typescript
io.on('connection', async (socket) => {
  // ... phần auth và join room hiện tại
  
  const userId = Number(socket.handshake.auth.user_id)
  
  // ✅ MỚI: Đánh dấu online trong Redis
  await setUserOnline(userId, socket.id)
  
  // ✅ MỚI: Lắng nghe heartbeat từ client
  socket.on('heartbeat', async () => {
    await setUserOnline(userId, socket.id)
  })
  
  // ... các handler khác (join_channel, send_message, ...)
})
```

**Trong `socket.on('disconnect')` — thêm setUserOffline:**

```typescript
socket.on('disconnect', async () => {
  const userId = Number(socket.handshake.auth.user_id)
  
  // ✅ MỚI: Xoá khỏi Redis presence
  await setUserOffline(userId, socket.id)
  
  // Giữ lại removeSocket (fallback cho in-memory)
  removeSocket(socket.id)
})
```

---

## 💻 Bước 3: Client gửi heartbeat mỗi 30s

Mở file client React tìm chỗ khởi tạo socket, thêm:

```javascript
useEffect(() => {
  const socket = io(SERVER_URL, {
    auth: { user_id: userId, access_token: token }
  })
  
  // ✅ MỚI: Gửi heartbeat mỗi 30s
  const heartbeatInterval = setInterval(() => {
    socket.emit('heartbeat')
  }, 30_000)
  
  // Cleanup khi unmount
  return () => {
    clearInterval(heartbeatInterval)
    socket.disconnect()
  }
}, [userId, token])
```

**Tại sao 30s?**
- Nhỏ hơn TTL (60s) → luôn refresh trước khi bị xoá.
- Không quá nhỏ để tránh spam server.
- 30s = cân bằng giữa freshness và overhead.

---

## 💻 Bước 4: (Optional) Server-side cleanup worker

Phòng trường hợp client crash mà không gửi disconnect:

Mở `src/services/presence.services.ts`, thêm hàm cleanup:

```typescript
/**
 * Cleanup idle sockets (không heartbeat trong X giây).
 * Gọi từ cron job mỗi 60s.
 */
export const cleanupIdlePresence = async (): Promise<void> => {
  const stream = redis.scanStream({
    match: `${redis.options.keyPrefix ?? 'chat:'}presence:user:*`
  })
  
  const cutoff = Date.now() - PRESENCE_TTL * 1000
  let cleaned = 0
  
  for await (const keys of stream) {
    for (const fullKey of keys) {
      // Bỏ prefix vì redis tự thêm
      const key = fullKey.replace(redis.options.keyPrefix ?? 'chat:', '')
      
      // Xoá members có score cũ
      const removed = await redis.zremrangebyscore(key, '-inf', cutoff)
      cleaned += removed
      
      // Nếu set rỗng → xoá key
      const count = await redis.zcard(key)
      if (count === 0) {
        await redis.del(key)
      }
    }
  }
  
  if (cleaned > 0) {
    console.log(`[Presence] cleaned ${cleaned} idle sockets`)
  }
}
```

Trong `src/index.ts`, thêm cron:

```typescript
import { cleanupIdlePresence } from '~/services/presence.services'

// Cleanup mỗi 60s
setInterval(() => {
  cleanupIdlePresence().catch(err => console.error('[Presence cleanup]', err))
}, 60_000)
```

**Lưu ý:** Phase 5 chỉ cần client heartbeat là đủ. Worker cleanup chỉ là safety net, có thể thêm sau.

---

## ✅ Checkpoint Phase 5

### Test

1. **Khởi động lại server:**
   ```bash
   npm run dev
   ```

2. **Mở client, login user A:**
   - Kiểm tra Redis:
     ```bash
     docker exec -it chat-redis redis-cli
     ```
     ```redis
     ZRANGE chat:presence:user:15 0 -1 WITHSCORES
     ```
   - Phải thấy 1 socketId với score = timestamp hiện tại.

3. **Mở tab thứ 2 (cùng user A):**
   ```redis
   ZRANGE chat:presence:user:15 0 -1 WITHSCORES
   ```
   - Phải thấy 2 socketId.

4. **Đóng 1 tab, đợi 5s:**
   ```redis
   ZRANGE chat:presence:user:15 0 -1 WITHSCORES
   ```
   - Phải còn 1 socketId.

5. **Đóng hết tab, đợi 5s:**
   ```redis
   EXISTS chat:presence:user:15
   ```
   - Trả về `0` (key không tồn tại).

6. **Test restart:**
   - Mở 1 tab, login.
   - Verify có key trong Redis.
   - `Ctrl+C` server, khởi động lại.
   - Mở lại tab (vẫn có session).
   - → User vẫn được track online (vì heartbeat sẽ refresh lại key).

7. **Test multi-instance:**
   - Terminal 1: `PORT=3001 npm run dev`
   - Terminal 2: `PORT=3002 npm run dev`
   - Tab 1: connect port 3001, login user A.
   - Tab 2: connect port 3002, login user B.
   - Trong cả 2 instance, gọi API check `isUserOnline(B)` → phải trả `true` ở cả 2.

### Checklist

- [ ] `presence.services.ts` đã tạo
- [ ] `socket.ts` đã thêm `setUserOnline/Offline` trong connection + disconnect
- [ ] Client gửi heartbeat mỗi 30s
- [ ] Test connect/disconnect cập nhật Redis đúng
- [ ] Test multi-instance: presence sync giữa 2 instance
- [ ] Test restart: presence không bị mất hoàn toàn

---

## 🐛 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|-----|-------------|----------|
| `keyPrefix` không khớp | Tự gõ `chat:` lúc scan | Dùng `redis.options.keyPrefix` |
| `score` là string | `Date.now()` trả number OK | Check syntax |
| Heartbeat không gửi | Client chưa thêm code | Sửa client |
| Key biến mất ngay sau khi set | `ZADD` chưa xong → `EXPIRE` chạy trên key chưa có | Đợi async đầy đủ |
| Score âm hoặc NaN | Truyền sai kiểu | Check `Date.now()` trả number |

### Debug

Tạm thời thêm log trong `setUserOnline`:

```typescript
export const setUserOnline = async (userId, socketId) => {
  const key = `presence:user:${userId}`
  const added = await redis.zadd(key, Date.now(), socketId)
  console.log(`[Presence] setUserOnline: user=${userId} socket=${socketId} added=${added}`)
  await redis.expire(key, PRESENCE_TTL * 2)
}
```

Sau khi test xong, **xoá log**.

---

## 📊 Kết quả Phase 5

| Tính năng | Trước (Map) | Sau (Sorted Set) |
|-----------|-------------|-------------------|
| Restart safety | ❌ Mất hết | ✅ Tự recover (TTL + heartbeat) |
| Multi-instance | ❌ Riêng biệt | ✅ Chia sẻ qua Redis |
| Auto cleanup idle | ❌ Phải tự quản | ✅ Score-based TTL |
| Memory cost | 1KB/user | ~100 bytes/user |
| Latency check online | O(1) Map | O(1) ZCARD |

---

## ⏭️ Phase tiếp theo

**[Phase 6: BullMQ - Queue + Worker →](./phase-06-bullmq-worker.md)**

Phase 6 sẽ tách phần xử lý "nặng" (DB write cho read-state, batch processing) ra khỏi main flow bằng BullMQ.
