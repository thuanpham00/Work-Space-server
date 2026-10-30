# Phase 4: REST `/channels/unread` Đọc Từ Redis

> ⏱️ **Thời gian:** 1–1.5 giờ
> 🎯 **Mục tiêu:** REST và socket dùng chung 1 nguồn sự thật → số badge luôn khớp; REST hết N+1 query
> 📍 **Vị trí code:** `src/services/channel.services.ts` (`getUnreadChannel`), `src/services/unread.services.ts`

---

## 🎯 Vấn đề

Hiện tại có **2 nơi** tính unread count, mỗi nơi 1 công thức:

| Nơi | Công thức | Query DB |
|---|---|---|
| REST `GET /channels/unread` | `createdAt > lastReadAt` | **N+1** (1 count query / channel) |
| Socket `channel_unread` (Phase 3) | Redis Hash `unread:{channelId}` | 0 |

### Hậu quả

1. **Số badge lệch giữa REST và realtime.** FE load REST lúc mount app → badge = 10. Sau đó có event socket → count = 11 → badge = 11. Nhưng lần refresh sau, REST trả 11 → khớp. Tạm ổn — **nhưng chỉ khi 2 công thức cho cùng kết quả**, hiện chưa chắc.

2. **REST chậm.** Channel của user = 20 → 20 count query + 2 query khác = 22 query DB mỗi lần FE load app. `staleTime: 15 phút` giảm tần suất, nhưng vẫn N+1.

3. **Hai nguồn sự thật.** Sau Phase 3, DB (`channel_read_states`) và Redis (`unread:{ch}`) có thể lệch nhau. REST đọc DB, socket đọc Redis → 2 con số khác nhau cho cùng 1 thời điểm.

---

## 📚 Lý thuyết tối thiểu

### Nguyên tắc: 1 nguồn sự thật, mọi nơi đọc từ đó

```
                    ┌─────────────────────┐
                    │  Redis Hash          │
                    │  unread:{channelId}  │  ← nguồn sự thật
                    └──────────┬──────────┘
                     ┌─────────┴─────────┐
                     ▼                   ▼
              Socket worker        REST /channels/unread
              (đọc HMGET)          (đọc HMGET)
```

### Vì sao không rollback về DB cho REST?

Có thể — nhưng thế thì socket (Redis) và REST (DB) lại lệch nhau.
Nếu giữ DB là nguồn sự thật thì socket phải query DB → mất lợi ích Phase 3.

→ **Chọn Redis làm nguồn sự thật**, DB chỉ giữ bản bền vững (reconcile Phase 5 đồng bộ ngược).

### Fallback khi Redis miss

Key `unread:{channelId}` có TTL 7 ngày. Nếu user lâu không vào channel → key hết hạn → REST trả count = 0 sai.

→ Cần fallback: **Redis miss → tính từ DB → set lại Redis**.

---

## 🔧 Bước 1: Thêm helper đọc count cho 1 channel

`src/services/unread.services.ts`:

```typescript
/**
 * Lấy unread count của 1 user trong 1 channel.
 * Nếu Redis miss → tính từ DB (fallback) rồi set lại Redis.
 *
 * @param lastReadMessageId Cutoff từ DB (dùng cho fallback)
 */
export const getUnreadCountForUser = async (
  channelId: string | number,
  userId: number,
  lastReadMessageId: bigint | null
): Promise<number> => {
  const key = unreadKey(channelId)

  // 1. Thử Redis
  const cached = await redis.hget(key, String(userId))
  if (cached !== null) {
    return Number(cached)
  }

  // 2. Redis miss → fallback tính từ DB
  const count = await databaseServices.prisma.message.count({
    where: {
      channelId: BigInt(channelId),
      id: { gt: lastReadMessageId ?? BigInt(0) },
      messageType: { not: 'CONFIG' }
    }
  })

  // 3. Set lại Redis (best-effort, không throw)
  await redis.hset(key, String(userId), count).catch(() => {})

  return count
}
```

Cần import `databaseServices` vào file này.

---

## 🔧 Bước 2: Sửa `getUnreadChannel` trong `src/services/channel.services.ts`

### Code hiện tại (đoạn cần sửa)

```typescript
async getUnreadChannel(userId: bigint) {
  const channelList = await databaseServices.prisma.channelMember.findMany({
    where: { userId: userId },
    select: { channelId: true, channel: true }
  })

  const channelIds = channelList.map((m) => m.channelId)
  if (channelIds.length === 0) return []

  const readChannelStateMap = new Map()
  const lastMessageMap = new Map()

  const readChannelStates = await databaseServices.prisma.channelReadState.findMany({
    where: { channelId: { in: channelIds }, userId: userId },
    select: { channelId: true, lastReadMessageId: true, lastReadAt: true }
  })

  for (const readChannelState of readChannelStates) {
    const key = readChannelState.channelId.toString()
    if (!readChannelStateMap.has(key)) {
      readChannelStateMap.set(key, readChannelState)
    }
  }

  const lastMessage = await databaseServices.prisma.message.findMany({
    where: { channelId: { in: channelIds }, messageType: { not: 'CONFIG' } },
    orderBy: { createdAt: 'desc' }
  })

  for (const message of lastMessage) {
    const key = message.channelId.toString()
    if (!lastMessageMap.has(key)) {
      lastMessageMap.set(key, message.id)
    }
  }

  return Promise.all(
    channelIds.map(async (channelId) => {
      // ... count query per channel ...
    })
  )
}
```

### Vấn đề khác: query `lastMessage` tải TOÀN BỘ message của mọi channel

```typescript
const lastMessage = await databaseServices.prisma.message.findMany({
  where: { channelId: { in: channelIds }, messageType: { not: 'CONFIG' } },
  orderBy: { createdAt: 'desc' }
})
```

→ Không có `take` → **tải hết mọi message của tất cả channel** vào RAM chỉ để lấy message mới nhất!

Ví dụ: 20 channel × 1000 message = 20.000 row bị load. Rất tệ.

**Cách sửa:** dùng `groupBy` hoặc raw query lấy max(id) mỗi channel.

### Code mới

```typescript
import { getUnreadCountForUser } from '~/services/unread.services'

async getUnreadChannel(userId: bigint) {
  // 1. Lấy channel user tham gia
  const channelList = await databaseServices.prisma.channelMember.findMany({
    where: { userId: userId },
    select: { channelId: true, channel: true }
  })

  const channelIds = channelList.map((m) => m.channelId)
  if (channelIds.length === 0) return []

  // 2. Lấy read state
  const readChannelStates = await databaseServices.prisma.channelReadState.findMany({
    where: { channelId: { in: channelIds }, userId: userId },
    select: { channelId: true, lastReadMessageId: true }
  })

  const readStateMap = new Map<string, bigint | null>()
  for (const state of readChannelStates) {
    readStateMap.set(state.channelId.toString(), state.lastReadMessageId)
  }

  // 3. Lấy message mới nhất MỖI channel (không tải toàn bộ)
  const lastMessageRows = await databaseServices.prisma.$queryRaw<
    { channelId: bigint; lastId: bigint }[]
  >`
    SELECT DISTINCT ON (channel_id)
      channel_id AS "channelId",
      id AS "lastId"
    FROM messages
    WHERE channel_id IN (${Prisma.join(channelIds)})
      AND message_type <> 'CONFIG'
    ORDER BY channel_id, id DESC
  `

  const lastMessageMap = new Map<string, bigint>()
  for (const row of lastMessageRows) {
    lastMessageMap.set(row.channelId.toString(), row.lastId)
  }

  // 4. Đọc count — Redis trước, fallback DB
  const results = await Promise.all(
    channelIds.map(async (channelId) => {
      const key = channelId.toString()
      const findChannel = channelList.find((c) => c.channelId === channelId)

      const count = await getUnreadCountForUser(
        channelId,
        Number(userId),
        readStateMap.get(key) ?? null
      )

      return {
        workspaceId: findChannel?.channel.workspaceId?.toString() ?? null,
        channelId: channelId.toString(),
        type: findChannel?.channel.type,
        lastMessageId: lastMessageMap.get(key)?.toString() ?? null,
        count: count,
        unread: count > 0
      }
    })
  )

  return results
}
```

---

## 🔧 Bước 3: Xử lý `Prisma.join` — cần import

```typescript
import { Prisma } from '~/generated/prisma/client'
```

> Kiểm tra đúng path import `Prisma` trong project (xem `src/generated/prisma/client.ts`).

### Nếu không muốn dùng raw SQL

Dùng `groupBy` (Prisma hỗ trợ `max`):

```typescript
const grouped = await databaseServices.prisma.message.groupBy({
  by: ['channelId'],
  where: {
    channelId: { in: channelIds },
    messageType: { not: 'CONFIG' }
  },
  _max: { id: true }
})

const lastMessageMap = new Map<string, bigint>()
for (const row of grouped) {
  lastMessageMap.set(row.channelId.toString(), row._max.id!)
}
```

→ **Không cần raw SQL**, 1 query, chạy được trên mọi DB provider. **Khuyến nghị dùng cách này.**

---

## ⚠️ Điểm cần kiểm tra: format của response

FE đang dùng:

```typescript
// client/src/types/channel.type.ts
export type ChannelUnread = {
  workspaceId: string;
  channelId: string;
  type: ChannelType;
  lastMessageId: string;
  count: number;
  unread: boolean;
};
```

Server hiện trả `channelId` và `lastMessageId` là **BigInt** → `JSON.stringify` với `BigInt.prototype.toJSON` đã patch trong `src/index.ts` → thành string. Nên về runtime là string.

→ Nhưng nên trả string tường minh (như code mới ở Bước 2) để rõ ràng.

**FE cần sửa type:** `workspaceId: string | null`.

---

## 📊 Đánh giá

| | Trước | Sau |
|---|---|---|
| Query DB của REST | N+1 (≈22 query / 20 channel) | **1–2 query** (read state + groupBy) |
| Redis ops của REST | 0 | N × 1 (`HGET` fallback) hoặc 1 pipeline |
| Nguồn sự thật | DB | **Redis** (khớp socket) |
| Message bị tải vào RAM | TẤT CẢ message của mọi channel | Chỉ 1 row/channel |

> **Tối ưu thêm (optional):** dùng `getUnreadCounts` (HMGET 1 round trip cho N channel)? Không được — mỗi channel là 1 hash riêng, nên vẫn N lệnh `HGET`. Dùng `Promise.all` để chạy song song (như code mới đã làm).

---

## 🐛 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|---|---|---|
| `BigInt` không serialize được | Trả BigInt trực tiếp | `.toString()` tường minh (đã làm) |
| `Prisma.join` không tồn tại | Import sai path | Dùng `groupBy` thay raw SQL (khuyến nghị) |
| `PrismaClientValidationError` | `groupBy` cần `orderBy` khi dùng `take/skip` | Không dùng `take/skip` ở đây |
| REST trả count = 0 nhưng socket có badge | Redis miss → fallback tính sai cutoff | Kiểm tra `readStateMap` có đúng `lastReadMessageId` |
| `groupBy` trả `_max.id = null` | Channel chưa có message | Guard `?? null` (đã có) |
| FE crash vì `workspaceId` null | Type FE ghi `string` | Sửa FE type → `string \| null` |

---

## ✅ Checkpoint Phase 4

- [ ] `getUnreadCountForUser` trong `unread.services.ts` (Redis + fallback DB)
- [ ] `getUnreadChannel` dùng `groupBy` thay `findMany` không giới hạn
- [ ] Response trả string tường minh cho `channelId`, `lastMessageId`, `workspaceId`
- [ ] FE type `ChannelUnread.workspaceId: string | null`
- [ ] Test: REST trả count khớp với badge socket

### Test ma trận

| Tình huống | Kỳ vọng |
|---|---|
| B có 3 tin chưa đọc | REST trả `count: 3`, `unread: true` |
| B đã đọc hết | REST trả `count: 0`, `unread: false` |
| REST gọi 2 lần liên tiếp | Lần 2 đọc Redis (nhanh hơn), count giống nhau |
| Redis bị flush | REST fallback DB → count đúng |
| Channel không có message | `lastMessageId: null`, `count: 0` |

---

## 🔜 Phase tiếp theo

**[Phase 5: Reconcile Job (tự sửa counter lệch) →](./phase-05-reconcile-job.md)**

Phase 5 bảo vệ Redis khỏi bị lệch so với DB → badge luôn đúng dù Redis mất dữ liệu.
