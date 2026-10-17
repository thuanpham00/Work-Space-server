# Phase 1: Cache channel members

> ⏱️ **Thời gian:** 30 phút
> 🎯 **Mục tiêu:** Bỏ query DB `channelMember.findMany` chạy cho MỖI message
> 📍 **Vị trí code:** `src/services/redis.services.ts` (mới) + `src/socket/utils.ts` (sửa)

---

## 🎯 Vấn đề hiện tại

Mở file `src/socket/utils.ts`, tìm hàm `emitUnreadChannel`. Bạn sẽ thấy:

```typescript
const members = await databaseServices.prisma.channelMember.findMany({
  where: { channelId, userId: { not: senderId } },
  select: { userId: true }
})
```

**Mỗi lần có message** → query này chạy.

**Tính toán:**
- Channel 1000 members × 10 message/phút = **10,000 query DB / phút**
- Chỉ riêng cho 1 channel!

Nếu 50 channel hoạt động → 500K query/phút → DB chết.

---

## 📚 Lý thuyết tối thiểu

### Cache-Aside Pattern (Lazy Loading)

```
Đ�ỌC:
  Key có trong Redis không?
    ├─ CÓ  → trả về luôn         (0 query DB)
    └─ KHÔNG → query DB
              → lưu kết quả vào Redis
              → trả về

XOÁ (invalidate):
  Xoá key trong Redis
  → Lần đọc sau sẽ miss → query lại DB → tự cập nhật cache
```

### Tại sao Cache-Aside, không phải Write-Through?

| Pattern | Ưu | Nhược |
|---------|----|----|
| **Cache-Aside** ✅ | DB là source of truth, cache chỉ là read | Cache miss 1 lần sau invalidate |
| Write-Through | Cache luôn fresh | Phải rollback nếu DB fail → phức tạp |

### Cấu trúc Redis: SET

```
Key:    chat:channel:10:members
Type:   Set
Members: ["15", "20", "30"]   (chuỗi, vì Redis không có number)
```

Các lệnh dùng:
- `SADD key member` — thêm member
- `SMEMBERS key` — lấy tất cả member
- `DEL key` — xoá key

### TTL (Time To Live)

```
EXPIRE key 300   ← tự xoá sau 300 giây (5 phút)
```

**Tại sao cần TTL?**
- Phòng trường hợp miss invalidate (cache cũ còn mãi).
- DB đã thay đổi mà cache không biết.
- Sau 5 phút cache tự expire → query lại DB → tự refresh.

---

## 💻 Bước 1: Tạo file `src/services/redis.services.ts`

```typescript
import Redis from 'ioredis'
import databaseServices from './database.services'

// ============ KẾT NỐI REDIS ============
// Tạo 1 connection dùng chung toàn app (singleton pattern)
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  keyPrefix: 'chat:'  // mọi key tự có prefix "chat:"
})

// Log khi connect/error để dễ debug
redis.on('connect', () => console.log('[Redis] connected'))
redis.on('error', (err) => console.error('[Redis] error:', err.message))

// ============ CONSTANTS ============
const MEMBER_TTL = 300  // 5 phút - key tự expire sau 5 phút

// ============ CHANNEL MEMBERS ============

/**
 * Lấy danh sách userId là member của channel.
 * 
 * Flow:
 * 1. Thử cache (Redis) trước
 * 2. Cache miss → query DB → lưu cache → trả về
 * 
 * @returns Array userId. Trả [] nếu channel không có members.
 */
export const getChannelMemberIds = async (channelId: number): Promise<number[]> => {
  const key = `channel:${channelId}:members`

  // 1. Thử cache
  const cached = await redis.smembers(key)
  if (cached.length > 0) {
    return cached.map(Number)  // Convert string[] → number[]
  }

  // 2. Cache miss → query DB
  const members = await databaseServices.prisma.channelMember.findMany({
    where: { channelId },
    select: { userId: true }
  })
  const userIds = members.map(m => m.userId)

  // 3. Ghi cache (chỉ khi có members)
  if (userIds.length > 0) {
    await redis.sadd(key, ...userIds.map(String))  // Convert number → string
    await redis.expire(key, MEMBER_TTL)             // Set TTL
  }

  return userIds
}

/**
 * Xoá cache khi membership thay đổi.
 * Gọi sau khi add/remove member.
 */
export const invalidateChannelMembers = async (channelId: number): Promise<void> => {
  await redis.del(`channel:${channelId}:members`)
}

export default redis
```

---

## 🔍 Giải thích code từng phần

### Phần 1: Khởi tạo Redis client

```typescript
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  keyPrefix: 'chat:'
})
```

| Dòng | Ý nghĩa |
|------|----------|
| `new Redis(URL)` | Tạo 1 connection tới Redis. ioredis tự reconnect nếu mất kết nối. |
| `keyPrefix: 'chat:'` | Mọi key bạn thao tác sẽ tự có prefix. Bạn gõ `channel:10`, Redis thực tế lưu `chat:channel:10`. |
| `process.env.REDIS_URL ?? 'redis://localhost:6379'` | Nếu env không có, dùng mặc định. Dấu `??` chỉ fallback khi null/undefined. |

### Phần 2: Hàm `getChannelMemberIds`

```typescript
const cached = await redis.smembers(key)
```

**Giải thích:** `SMEMBERS` trả về tất cả members của 1 Set. Ví dụ:
- Key `chat:channel:10:members` chứa `["15", "20", "30"]`
- `redis.smembers('channel:10:members')` (do có prefix) trả về `["15", "20", "30"]`

```typescript
if (cached.length > 0) {
  return cached.map(Number)
}
```

**Giải thích:** Nếu cache có data → return ngay, KHÔNG query DB. Convert `["15", "20"]` → `[15, 20]`.

```typescript
const members = await databaseServices.prisma.channelMember.findMany({...})
const userIds = members.map(m => m.userId)
```

**Giải thích:** Cache miss → query DB. Lấy danh sách `userId` thôi (dùng `select` để tiết kiệm bandwidth).

```typescript
await redis.sadd(key, ...userIds.map(String))
```

**Giải thích:** Spread array thành nhiều arguments. Nếu `userIds = [15, 20]`, lệnh thành `SADD key 15 20`. Dấu `...` (spread) là cú pháp ES6.

```typescript
await redis.expire(key, MEMBER_TTL)
```

**Giải thích:** Set TTL 300s. Sau 5 phút key tự xoá, lần đọc sau sẽ miss → query lại DB.

### Phần 3: Hàm `invalidateChannelMembers`

```typescript
export const invalidateChannelMembers = async (channelId: number): Promise<void> => {
  await redis.del(`channel:${channelId}:members`)
}
```

**Giải thích:** Xoá cache ngay lập tức khi membership thay đổi. Gọi hàm này ở bất kỳ đâu có thêm/xoá member.

---

## 💻 Bước 2: Sửa `src/socket/utils.ts`

Mở file, tìm hàm `emitUnreadChannel`. Thay đổi phần query members.

**Import thêm ở đầu file (nếu chưa có):**

```typescript
import redisServices from '~/services/redis.services'
```

**Tìm đoạn này:**

```typescript
const members = await databaseServices.prisma.channelMember.findMany({
  where: { channelId, userId: { not: senderId } },
  select: { userId: true }
})

for (const member of members) {
  io.to(Socket_Room.user(member.userId.toString())).emit('channel_unread', {
    channelId, workspaceId: channel.workspaceId, latestMessageId
  })
}
```

**Thay bằng:**

```typescript
const allMembers = await redisServices.getChannelMemberIds(channelId)
const recipients = allMembers.filter(uid => uid !== senderId)

for (const uid of recipients) {
  io.to(Socket_Room.user(uid.toString())).emit('channel_unread', {
    channelId, workspaceId: channel.workspaceId, latestMessageId
  })
}
```

### So sánh

| Trước | Sau |
|-------|-----|
| `prisma.channelMember.findMany(...)` | `getChannelMemberIds(channelId)` |
| Query DB MỖI message | Cache hit → 0 query |
| `userId: { not: senderId }` (SQL filter) | `filter(uid => uid !== senderId)` (JS filter) |

**Tại sao filter ở JS, không phải SQL?**
- Vì cache trả về TẤT CẢ members (không cần tham số loại trừ sender).
- Filter ở JS chỉ tốn 1 lần duy nhất khi gọi (cache hit) → không ảnh hưởng performance.

---

## 💻 Bước 3: Invalidate cache khi thay đổi membership

Mở `src/services/channel.services.ts`. Tìm chỗ nào có:
- `prisma.channelMember.create` (thêm member)
- `prisma.channelMember.delete` (xoá member)
- `prisma.channelMember.createMany` (thêm nhiều)

**Sau mỗi operation đó, thêm 1 dòng:**

```typescript
import redisServices from '~/services/redis.services'

// Ví dụ: trong hàm addMemberToChannel
await databaseServices.prisma.channelMember.create({...})
await redisServices.invalidateChannelMembers(channelId)  // ← thêm dòng này

// Ví dụ: trong hàm removeMemberFromChannel
await databaseServices.prisma.channelMember.delete({...})
await redisServices.invalidateChannelMembers(channelId)  // ← thêm dòng này
```

**Tại sao phải invalidate?**
- Khi thêm member mới: cache cũ không có userId mới → unread notification sẽ bị miss.
- Khi xoá member: cache vẫn còn userId đã xoá → emit cho user không còn trong channel.
- → Cần xoá cache để lần đọc sau query lại DB.

---

## ✅ Checkpoint Phase 1

### Bước kiểm tra

1. **Khởi động server:**
   ```bash
   npm run dev
   ```
   Console phải log: `[Redis] connected`

2. **Gửi 1 message trong channel có members:**
   - Mở client React, gửi 1 message vào channel bất kỳ.

3. **Kiểm tra Redis:**
   ```bash
   docker exec -it chat-redis redis-cli
   ```
   ```redis
   KEYS chat:*
   ```
   Kết quả: phải thấy `chat:channel:10:members` (hoặc channel ID tương ứng).
   
   ```redis
   SMEMBERS chat:channel:10:members
   ```
   Kết quả: danh sách userId là string: `["15", "20", "30"]`.
   
   ```redis
   TTL chat:channel:10:members
   ```
   Kết quả: số giây còn lại (≤ 300).

4. **Test invalidate:**
   - Thêm 1 member mới vào channel (qua API hoặc DB).
   - Trong redis-cli, gõ `KEYS chat:*` → cache biến mất.
   - Gửi message mới → cache tự tạo lại với member mới.

### Checklist

- [ ] File `redis.services.ts` đã tạo, không có lỗi TypeScript
- [ ] Hàm `emitUnreadChannel` đã dùng `getChannelMemberIds`
- [ ] Server vẫn chạy bình thường, console có `[Redis] connected`
- [ ] `redis-cli KEYS chat:*` thấy key members sau khi gửi message
- [ ] `TTL` cho thấy giá trị ~300
- [ ] Test gửi message: recipient vẫn nhận `channel_unread` như cũ
- [ ] Thêm/xoá member → cache bị invalidate đúng

---

## 🐛 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|-----|-------------|----------|
| `ECONNREFUSED 127.0.0.1:6379` | Redis chưa chạy | `docker ps` kiểm tra, `docker start chat-redis` |
| `TypeError: redis.smembers is not a function` | Sai import | Check `import Redis from 'ioredis'` |
| Cache không có gì khi `KEYS chat:*` | Channel rỗng hoặc chưa gửi message | Test với channel có ≥ 2 members |
| `Cannot find module '~/services/redis.services'` | Sai alias path | Kiểm tra `tsconfig.json` có path alias `~` → `./src` |
| Cache vẫn có member đã xoá | Quên gọi `invalidateChannelMembers` | Check lại channel.services.ts |
| TypeScript error `Property 'smembers' does not exist` | Thiếu type | Restart TS server, hoặc `npm install` lại |

---

## 📊 Kết quả Phase 1

| Metric | Trước | Sau |
|--------|-------|-----|
| Query DB cho channel members / message | 1 | 0 (cache hit) |
| Latency phần query members | ~10ms | ~0.5ms |
| DB load từ `emitUnreadChannel` | 100% | < 5% (chỉ khi miss cache) |

**Test với 1 channel 1000 members, 10 msg/phút:**
- Trước: 10 query/phút
- Sau: 0.033 query/phút (1 lần / 5 phút khi miss)

**Tiết kiệm: ~99.7% query cho phần này.**

---

## ⏭️ Phase tiếp theo

**[Phase 2: Cache workspace của channel →](./phase-02-cache-workspace.md)**

Phase 2 sẽ cache tiếp `channel.workspaceId` để bỏ nốt query DB còn lại trong `emitUnreadChannel`.
