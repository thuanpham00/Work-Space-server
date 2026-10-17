# Phase 2: Cache workspace của channel

> ⏱️ **Thời gian:** 15 phút
> 🎯 **Mục tiêu:** Bỏ query DB `channel.findUnique({select: workspaceId})` trong `emitUnreadChannel`
> 📍 **Vị trí code:** `src/services/redis.services.ts` (thêm) + `src/socket/utils.ts` (sửa)

---

## 🎯 Vấn đề hiện tại

Trong `src/socket/utils.ts`, hàm `emitUnreadChannel` còn query thứ 2:

```typescript
const channel = await databaseServices.prisma.channel.findFirst({
  where: { id: channelId },
  select: { workspaceId: true }
})
if (!channel) return
// dùng channel.workspaceId ở các emit bên dưới
```

**Mục đích:** Biết `workspaceId` để gắn vào event `channel_unread` (client cần để update badge count theo workspace).

Cùng pattern với Phase 1 nhưng giá trị đơn (1 số, không phải Set).

---

## 📚 Lý thuyết tối thiểu

### Cấu trúc Redis: STRING

```
Key:    chat:channel:10:workspace
Type:   String
Value:  "5"   (chuỗi, Redis không có number riêng)
```

### Các lệnh dùng

| Lệnh | Cú pháp | Tác dụng |
|------|---------|----------|
| `GET` | `GET key` | Lấy giá trị. Trả `null` nếu không có. |
| `SET` | `SET key value EX 300` | Set giá trị + TTL trong 1 lệnh atomic. |

### Tại sao `SET ... EX` tốt hơn `SET` + `EXPIRE` riêng?

```
# ❌ Hai lệnh, không atomic
SET key value
EXPIRE key 300
# Có thể: SET thành công, EXPIRE thất bại → key không TTL → cache vĩnh viễn

# ✅ Một lệnh, atomic
SET key value EX 300
# Hoặc tất cả thành công, hoặc không có gì thay đổi
```

---

## 💻 Bước 1: Thêm hàm vào `src/services/redis.services.ts`

Mở file `redis.services.ts`, **sau phần members**, thêm:

```typescript
// ============ CHANNEL WORKSPACE ============

const WORKSPACE_TTL = 600  // 10 phút - workspace ít thay đổi

/**
 * Lấy workspaceId của channel.
 * - Cache hit: ~0.3ms
 * - Cache miss: query DB + lưu cache
 * 
 * @returns workspaceId hoặc null nếu channel không tồn tại
 */
export const getChannelWorkspaceId = async (
  channelId: number
): Promise<number | null> => {
  const key = `channel:${channelId}:workspace`

  // 1. Thử cache trước
  const cached = await redis.get(key)
  if (cached !== null) {
    return Number(cached)  // Convert string → number
  }

  // 2. Cache miss → query DB
  const channel = await databaseServices.prisma.channel.findUnique({
    where: { id: channelId },
    select: { workspaceId: true }
  })
  if (!channel) return null

  // 3. Ghi cache với TTL (set + expire trong 1 lệnh atomic)
  await redis.set(key, channel.workspaceId, 'EX', WORKSPACE_TTL)

  return channel.workspaceId
}

/**
 * Xoá cache khi channel.workspaceId thay đổi.
 * (Hiếm khi xảy ra, nhưng cần có để đảm bảo consistency)
 */
export const invalidateChannelWorkspace = async (channelId: number): Promise<void> => {
  await redis.del(`channel:${channelId}:workspace`)
}
```

---

## 🔍 Giải thích code

### Hàm `getChannelWorkspaceId`

```typescript
const cached = await redis.get(key)
if (cached !== null) {
  return Number(cached)
}
```

**Giải thích:**
- `redis.get(key)` trả về `string | null`.
- Nếu key không tồn tại → `null`.
- Nếu có → giá trị string (ví dụ `"5"`).
- `Number("5")` → `5`.

```typescript
const channel = await databaseServices.prisma.channel.findUnique({...})
if (!channel) return null
```

**Giải thích:**
- `findUnique` trả `null` nếu không tìm thấy (khác `findFirst` trả `null` luôn).
- Check `!channel` để return sớm, không cache giá trị `null`.

```typescript
await redis.set(key, channel.workspaceId, 'EX', WORKSPACE_TTL)
```

**Giải thích:**
- `redis.set(key, value, 'EX', seconds)` — set value + TTL atomic.
- Tương đương `SET key value EX 600` trong redis-cli.

### Tại sao TTL 600s (10 phút)?

- Workspace ID của channel gần như KHÔNG BAO GIỜ thay đổi (channel ở workspace nào thì ở đó mãi).
- TTL 10 phút chỉ là safety net phòng trường hợp hi hữu.
- Bạn có thể set cao hơn (1 ngày, 1 tuần) mà không lo cache stale.

---

## 💻 Bước 2: Sửa `src/socket/utils.ts`

Mở file, tìm hàm `emitUnreadChannel`. Tìm đoạn này:

```typescript
const channel = await databaseServices.prisma.channel.findFirst({
  where: { id: channelId },
  select: { workspaceId: true }
})
if (!channel) return
```

**Thay bằng:**

```typescript
const workspaceId = await redisServices.getChannelWorkspaceId(channelId)
if (workspaceId === null) return
```

**Tìm tiếp các chỗ dùng `channel.workspaceId`:**

```typescript
// Trước
io.to(Socket_Room.user(...)).emit('channel_unread', {
  channelId,
  workspaceId: channel.workspaceId,  // ← thay
  latestMessageId
})
```

**Sửa thành:**

```typescript
// Sau
io.to(Socket_Room.user(...)).emit('channel_unread', {
  channelId,
  workspaceId,  // ← dùng biến mới
  latestMessageId
})
```

---

## 💻 Bước 3: Invalidate khi channel chuyển workspace

**Hiếm khi xảy ra**, nhưng nếu có API cho phép move channel giữa workspaces, cần invalidate.

Mở `src/services/channel.services.ts`, tìm chỗ nào update `channel.workspaceId`. Thêm:

```typescript
await databaseServices.prisma.channel.update({
  where: { id: channelId },
  data: { workspaceId: newWorkspaceId }
})
await redisServices.invalidateChannelWorkspace(channelId)  // ← thêm
```

**Nếu API không có tính năng move channel**, bạn có thể bỏ qua bước này (vì key không bao giờ sai).

---

## ✅ Checkpoint Phase 2

### Test

1. **Khởi động lại server:**
   ```bash
   npm run dev
   ```

2. **Gửi 1 message:**
   - Mở client React, gửi message vào channel bất kỳ.

3. **Kiểm tra Redis:**
   ```bash
   docker exec -it chat-redis redis-cli
   ```
   ```redis
   KEYS chat:*
   ```
   Phải thấy 2 loại key:
   - `chat:channel:10:members`
   - `chat:channel:10:workspace`
   
   ```redis
   GET chat:channel:10:workspace
   ```
   Trả về workspaceId dạng string, ví dụ: `"5"`.
   
   ```redis
   TTL chat:channel:10:workspace
   ```
   Trả về ~600s.

4. **Verify trong code:**
   - Mở `src/socket/utils.ts`, tìm `emitUnreadChannel`.
   - Đảm bảo **không còn** `prisma.channel.findFirst` trong hàm này.

### Checklist

- [ ] `getChannelWorkspaceId` đã thêm vào `redis.services.ts`
- [ ] `emitUnreadChannel` không còn query `channel` table
- [ ] Server vẫn hoạt động, gửi message OK
- [ ] `redis-cli GET chat:channel:X:workspace` trả về đúng workspaceId
- [ ] `channel_unread` event vẫn có `workspaceId` đúng

---

## 🐛 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|-----|-------------|----------|
| `workspaceId` luôn là `null` | Cache trả về null, DB cũng null | Check channel ID có tồn tại trong DB |
| Cache không có gì | Quên gọi sau khi channel được tạo | Check API create channel |
| Event `channel_unread` thiếu `workspaceId` | Quên sửa chỗ emit | Search tất cả `channel.workspaceId` |

---

## 📊 Kết quả Phase 2

| Metric | Trước | Sau Phase 1 | Sau Phase 2 |
|--------|-------|-------------|-------------|
| Query DB / message trong `emitUnreadChannel` | 2 | 1 | 0 |
| Latency phần query | ~12ms | ~5ms | ~0.8ms |

**Tổng query DB cho cả hệ thống khi gửi message:**
- Trước: 4 query (message insert + attachments + channel.workspaceId + channelMember)
- Sau Phase 1+2: 2 query (message insert + attachments)
- **Giảm 50% query DB!**

---

## ⏭️ Phase tiếp theo

**[Phase 3: Parallel emit →](./phase-03-parallel-emit.md)**

Phase 3 sẽ cải thiện latency bằng cách emit cho N members **song song** thay vì tuần tự.
