# Phase 3: Redis Unread Counter (HINCRBY)

> ⏱️ **Thời gian:** 2–2.5 giờ
> 🎯 **Mục tiêu:** Đường nóng (gửi tin) **0 query DB** cho việc đếm unread; worker đọc count từ Redis
> 📍 **Vị trí code:** `src/services/unread.services.ts` (mới), `src/socket/utils.ts`, `src/queues/unread.worker.ts`

---

## 🎯 Vấn đề

Sau Phase 1–2, mỗi job của worker vẫn tốn **~3 query DB** để tính count:

```
Job (1 channel, 500 members):
  1. channelReadState.findMany()      → 1 query
  2. message.count() × #cutoff        → 1–3 query
  ────────────────────────────────────
  Tổng: ~3 query DB mỗi job
```

Và **đường nóng** (`handleSendMessage`) hiện tại:

```
  1. prisma.message.create()          → 1 query DB (bắt buộc, không tránh được)
  2. getChannelWorkspaceId()           → Redis cached
  3. enqueueUnread()                   → Redis LPUSH
```

Ở scale 100 msg/s với 50 channel hoạt động → 100 job/s × 3 query = **300 query DB/s** chỉ để đếm unread.

---

## 📚 Lý thuyết tối thiểu

### Redis Hash

```
Key:   chat:unread:10          (unread:10 sau khi ioredis tự thêm prefix "chat:")
Type:  Hash
Field: userId
Value: số tin chưa đọc

HGETALL chat:unread:10
→ { "15": "3", "20": "0", "30": "7" }
```

**Tại sao Hash chứ không phải String/Set?**

| Lệnh | Hash | Set | String |
|---|---|---|---|
| `HINCRBY unread:10 15 1` | ✅ O(1), atomic | ❌ phải đọc→cộng→ghi (race) | ❌ phải đọc→cộng→ghi |
| `HMGET unread:10 15 20 30` | ✅ 1 round trip cho N field | ❌ phải `SMEMBERS` rồi lọc | ❌ N lần GET |
| `HSET unread:10 20 0` (reset) | ✅ | ❌ phải xoá rồi add | ❌ |

Hash là lựa chọn duy nhất cho cả 3 thao tác: increment atomic, đọc nhiều 1 lần, reset 1 field.

### Tại sao increment ở WRITE path, không ở worker?

```
Message được tạo đúng 1 lần (trong handleSendMessage).
Worker có thể retry job (BullMQ attempts: 3 + backoff).
```

| Vị trí increment | Worker retry | Kết quả |
|---|---|---|
| **Write path** (`handleSendMessage`) | Không liên quan | ✅ Tăng đúng 1 lần / message |
| Worker | Job retry → `HINCRBY` lần 2 | ❌ Đếm thừa |

→ **Increment ngay sau khi tạo message.** Worker chỉ **đọc**.

### Multi-instance

`HINCRBY` là atomic trên Redis server → không race dù bao nhiêu instance. Nhưng chỉ instance **xử lý socket `send_message`** mới increment → mỗi message chỉ tăng 1 lần. Đúng.

---

## 🔧 Bước 1: Tạo `src/services/unread.services.ts`

```typescript
import { redis } from '~/services/redis.services'

// ============ KEYS ============
const unreadKey = (channelId: string | number) => `unread:${channelId}`

// TTL cho hash unread — đủ lâu để user offline quay lại vẫn thấy badge,
// nhưng tự dọn nếu channel không hoạt động lâu.
const UNREAD_TTL = 60 * 60 * 24 * 7 // 7 ngày

// ============ INCREMENT ============
/**
 * Tăng unread count cho 1 user trong channel.
 *
 * Dùng khi có message mới gửi tới channel.
 * KHÔNG gọi cho message type CONFIG.
 */
export const incrementUnread = async (
  channelId: string | number,
  userId: number,
  amount = 1
): Promise<void> => {
  await redis.hincrby(unreadKey(channelId), String(userId), amount)
}

/**
 * Tăng unread count cho nhiều user trong 1 channel (1 round trip).
 *
 * Dùng trong write path: sau khi tạo message, tăng cho tất cả member
 * (trừ người gửi).
 */
export const incrementUnreadBatch = async (
  channelId: string | number,
  userIds: number[],
  amount = 1
): Promise<void> => {
  if (userIds.length === 0) return

  const key = unreadKey(channelId)
  const pipeline = redis.pipeline()

  for (const userId of userIds) {
    pipeline.hincrby(key, String(userId), amount)
  }
  pipeline.expire(key, UNREAD_TTL)

  await pipeline.exec()
}

// ============ RESET ============
/**
 * Reset unread count của 1 user về 0 (khi user đọc channel).
 */
export const resetUnread = async (
  channelId: string | number,
  userId: number
): Promise<void> => {
  await redis.hset(unreadKey(channelId), String(userId), 0)
}

// ============ READ ============
/**
 * Đọc count của nhiều user trong 1 channel (1 round trip).
 *
 * @returns Map userId → count (thiếu user = 0)
 */
export const getUnreadCounts = async (
  channelId: string | number,
  userIds: number[]
): Promise<Map<number, number>> => {
  const result = new Map<number, number>()
  if (userIds.length === 0) return result

  const values = await redis.hmget(unreadKey(channelId), ...userIds.map(String))

  userIds.forEach((userId, index) => {
    const raw = values[index]
    result.set(userId, raw === null ? 0 : Number(raw))
  })

  return result
}

/**
 * Đọc count của tất cả user trong 1 channel (dùng cho REST).
 */
export const getAllUnreadCounts = async (
  channelId: string | number
): Promise<Map<number, number>> => {
  const result = new Map<number, number>()
  const raw = await redis.hgetall(unreadKey(channelId))

  for (const [userId, count] of Object.entries(raw)) {
    result.set(Number(userId), Number(count))
  }

  return result
}

// ============ INVALIDATE ============
/**
 * Xoá toàn bộ counter của channel (khi channel bị xoá).
 */
export const invalidateUnread = async (channelId: string | number): Promise<void> => {
  await redis.del(unreadKey(channelId))
}
```

---

## 🔧 Bước 2: Write path — increment sau khi tạo message

`src/socket/utils.ts` → `handleSendMessage`:

```typescript
import { getChannelMemberIds } from '~/services/redis.services'
import { incrementUnreadBatch } from '~/services/unread.services'

// ... sau khi emit receive_message ...

const workspaceId = await getChannelWorkspaceId(channelId.toString())

// Tăng unread counter cho tất cả member (trừ người gửi).
// Redis cached → 0 query DB. 1 pipeline = 1 round trip.
const members = await getChannelMemberIds(channelId.toString())
const recipients = members.filter((member) => member !== userId)
await incrementUnreadBatch(channelId, recipients)

enqueueUnread({
  channelId,
  workspaceId,
  senderId: userId,
  messageId: Number(res.id),
  createdAt: new Date().toISOString()
}).catch((err) => console.error('[enqueueUnread]', err))
```

Làm tương tự cho `handleSendGif`.

> ⚠️ **Thứ tự quan trọng:** increment **sau khi** `message.create` thành công. Nếu create fail → không increment.
> ⚠️ **Không** increment cho message type `CONFIG` — hiện chỉ socket path tạo TEXT/GIF nên tự nhiên đúng. Nếu sau này thêm path tạo CONFIG → phải guard.

---

## 🔧 Bước 3: Read path — reset counter khi user đọc channel

`src/socket/utils.ts` → `upsertChannelReadState`: thêm reset Redis.

```typescript
import { resetUnread } from '~/services/unread.services'

export const upsertChannelReadState = async (
  userId: number,
  channelId: number,
  lastReadMessageId?: number
) => {
  const latestMessageId = lastReadMessageId ?? (
    await databaseServices.prisma.message.findFirst({
      where: { channelId },
      orderBy: { id: 'desc' },
      select: { id: true }
    })
  )?.id

  await databaseServices.prisma.channelReadState.upsert({
    where: { userId_channelId: { userId, channelId } },
    create: { userId, channelId, lastReadMessageId: latestMessageId, lastReadAt: new Date() },
    update: { lastReadMessageId: latestMessageId, lastReadAt: new Date() }
  })

  // Reset counter Redis (Phase 3) — đồng bộ với DB
  await resetUnread(channelId, userId)
}
```

> ⚠️ **Thứ tự:** reset Redis **sau khi** upsert DB thành công. Nếu upsert fail → không reset (giữ count cũ, an toàn hơn là mất count).

**Vì sao reset ở đây mà không ở handler `join_channel`/`leave_channel`?**
→ `upsertChannelReadState` đã được gọi ở cả 2 nơi (Phase 2) → 1 chỗ duy nhất, không sót.

---

## 🔧 Bước 4: Worker — đọc count từ Redis thay vì query DB

`src/queues/unread.worker.ts`:

**Xoá** hàm `getUnreadCounts` (bản DB ở Phase 1) và import bản Redis:

```typescript
import { getUnreadCounts } from '~/services/unread.services'
```

**Sửa** vòng lặp emit:

```typescript
for (const [channelId, group] of groups) {
  const members = await getChannelMemberIds(channelId.toString())
  const recipients = members.filter((user) => !group.senders.has(user))
  if (recipients.length === 0) continue

  const [channelType, workspaceId] = await Promise.all([
    getChannelType(channelId.toString()),
    getChannelWorkspaceId(channelId.toString())
  ])

  // Đọc count từ Redis (1 round trip cho toàn bộ recipients)
  const countMap = await getUnreadCounts(channelId, recipients)

  for (const userId of recipients) {
    const count = countMap.get(userId) ?? 0
    if (count === 0) continue

    const payload: ChannelUnreadPayload = {
      channelId: String(channelId),
      workspaceId: workspaceId === null ? null : String(workspaceId),
      type: channelType ?? 'TEXT',
      count,
      lastMessageId: String(group.latestMessageId),
      senderId: String(group.latestSenderId)
    }

    io.to(Socket_Room.user(String(userId))).emit('channel_unread', payload)
  }

  recipientCount += recipients.length
  channelCount++
}
```

**Xoá** import `databaseServices` nếu không còn dùng.

---

## 🔧 Bước 5: `handleSendMessage` — lấy member list 1 lần

Hiện tại worker gọi `getChannelMemberIds` và write path cũng gọi → 2 lần đọc cache. Không sao (cache hit rẻ), nhưng có thể tối ưu sau.

**Không cần làm gì ở phase này.**

---

## 📊 Đánh giá

| | Phase 1–2 (DB) | Phase 3 (Redis) |
|---|---|---|
| Query DB trên đường nóng | 0 (chưa tăng count) | **0** |
| Query DB trên đường emit | ~3/channel | **0** |
| Redis ops đường nóng | 0 | 1 pipeline / message |
| Redis ops đường emit | ~2 | ~3 |
| Nguồn sự thật | DB (`channel_read_states`) | **Redis Hash** |
| Tự lành khi lệch | ✅ luôn đúng | ❌ cần reconcile (Phase 5) |

---

## ⚠️ Rủi ro mới: Redis là nguồn sự thật → có thể lệch

| Rủi ro | Khi nào | Hậu quả | Xử lý |
|---|---|---|---|
| Redis mất dữ liệu | Redis chưa bật AOF, hoặc restart không persist | Badge về 0 sai | **Phase 5** (reconcile) + bật AOF |
| Message tạo ngoài socket path | Thêm REST endpoint gửi tin sau này | Không increment → thiếu badge | Guard ở mọi path tạo message |
| `upsertChannelReadState` fail | DB lỗi | Count không reset → badge tồn đọng | Reset Redis chỉ sau khi DB thành công (đã làm) |
| Worker đọc count trước khi increment | Worker pick job nhanh hơn write path | count = cũ (thiếu 1) | **Đây là vấn đề thật** — xem bên dưới |

### Vấn đề race: worker đọc count trước khi increment

Timeline:
```
t0: handleSendMessage → message.create() xong
t1: incrementUnreadBatch() chưa xong (đang pipeline)
t2: enqueueUnread() → buffer
t3: aggregator flush (1s sau) → BullMQ job
t4: worker đọc count → ĐÃ có increment (t1 xong trước t3) ✓
```

→ An toàn vì **aggregator flush sau 1 giây**, `incrementUnreadBatch` hoàn tất trong vài ms.

**Nhưng** nếu `incrementUnreadBatch` **chậm bất thường** (>1s, ví dụ Redis bị nghẽn) → worker đọc count cũ → badge thiếu 1.

→ **Phòng ngừa:** await `incrementUnreadBatch` **trước** `enqueueUnread` (đã đúng thứ tự trong code mẫu ở Bước 2).

---

## 🔧 Bước 6: Bật AOF cho Redis (khuyến nghị)

Docker:

```bash
docker run -d --name chat-redis -p 6379:6379 redis:7-alpine \
  redis-server --appendonly yes --appendfsync everysec
```

Nếu container đã tồn tại:

```bash
docker exec chat-redis redis-cli CONFIG SET appendonly yes
docker exec chat-redis redis-cli CONFIG SET appendfsync everysec
```

> `everysec` = mất tối đa 1 giây dữ liệu khi crash. Đủ tốt cho unread counter (mất 1s counter → reconcile sửa được).

---

## 🐛 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|---|---|---|
| `HINCRBY` không có tác dụng | Key sai prefix | Kiểm tra: `redis-cli KEYS 'chat:unread:*'` (ioredis tự thêm prefix) |
| `count` luôn 0 trong worker | Chưa gọi `incrementUnreadBatch` | Kiểm tra log write path |
| Badge không về 0 sau khi đọc | Chưa gọi `resetUnread` | Kiểm tra `upsertChannelReadState` |
| Count tăng 2 lần | Increment ở cả write path và worker | Xoá increment ở worker (chỉ đọc) |
| `EXPIRE` bị xoá sau mỗi HINCRBY | Không set TTL | Pipeline `expire` sau `hincrby` (đã có) |
| Hash phình to | Field của user đã rời channel không xoá | `HDEL` khi user rời channel (optional) |

### Debug nhanh

```bash
# Xem counter của channel 10
docker exec -it chat-redis redis-cli HGETALL chat:unread:10

# Reset counter (test)
docker exec -it chat-redis redis-cli DEL chat:unread:10

# Theo dõi lệnh Redis
docker exec -it chat-redis redis-cli MONITOR | grep -i unread
```

---

## ✅ Checkpoint Phase 3

- [ ] File `src/services/unread.services.ts` đã tạo
- [ ] `handleSendMessage` + `handleSendGif` gọi `incrementUnreadBatch`
- [ ] `upsertChannelReadState` gọi `resetUnread` (sau khi upsert DB thành công)
- [ ] Worker dùng `getUnreadCounts` từ Redis, xoá bản query DB
- [ ] Redis bật AOF
- [ ] Test: A gửi 3 tin cho B offline → B online → badge = 3, đúng

### Test ma trận

| Tình huống | Kỳ vọng |
|---|---|
| A gửi 3 tin, B chưa mở app | `HGETALL chat:unread:{ch}` → B = 3 |
| B mở channel → đọc | B = 0 |
| A gửi thêm 2 tin | B = 2 |
| B mở app (offline→online) | badge = 2 |
| 2 instance cùng Redis, A ở instance 1, B ở instance 2 | B nhận event, count đúng |

---

## 🔜 Phase tiếp theo

**[Phase 4: REST `/channels/unread` đọc từ Redis →](./phase-04-rest-unread-from-redis.md)**

Phase 4 làm REST và socket dùng chung 1 nguồn sự thật → số badge luôn khớp.
