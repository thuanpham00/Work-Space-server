# Lưu ý viết Service — tránh query Prisma không tối ưu

Tài liệu tham chiếu khi viết logic trong `src/services/**`. Mục tiêu: **ít round-trip DB**, **ít row trả về**, **đúng field cần dùng**.

---

## 1. Tránh N+1 query

```typescript
// ❌ Mỗi vòng lặp = 1 query mới
for (const channel of channels) {
  await prisma.message.findFirst({ where: { channelId: channel.id } })
}

// ✅ Gom 1 lần
await prisma.message.findMany({
  where: { channelId: { in: channelIds } }
})
```

**Rule:** Có `for/await` + `prisma.*` trong loop → dừng lại, tìm cách batch.

---

## 2. Chỉ `select` / `include` field cần thiết

```typescript
// ❌ Kéo full user (kể cả password)
include: { sender: true }

// ✅ Chỉ field public
include: {
  sender: {
    select: {
      id: true,
      username: true,
      displayName: true,
      avatar: true,
      status: true,
      fullName: true
    }
  }
}
```

**Rule:** Không bao giờ `user: true` hoặc `sender: true` khi trả data ra API.

---

## 3. Luôn paginate list lớn

```typescript
// ❌ Kéo hết bảng
await prisma.message.findMany({ where: { channelId } })

// ✅ Có giới hạn
await prisma.message.findMany({
  where: { channelId },
  take: limit,
  skip: (page - 1) * limit,
  orderBy: { createdAt: 'desc' }
})
```

Áp dụng cho: messages, attachments, friends, users search, v.v.

---

## 4. `orderBy` global ≠ “1 record mỗi nhóm”

```typescript
// ❌ Tưởng lấy tin mới nhất mỗi channel
await prisma.message.findMany({
  where: { channelId: { in: channelIds } },
  orderBy: { createdAt: 'desc' }
})
// → Trả về TẤT CẢ tin, sort chung 1 list
```

**Cách đúng:**

| Nhu cầu | Giải pháp |
|---------|-----------|
| Latest per channel (PostgreSQL) | `$queryRaw` + `DISTINCT ON (channel_id)` |
| Latest per channel (Prisma thuần) | Loop first-wins **chỉ khi** data nhỏ, hoặc tránh |
| Filter theo relation | `where: { message: { channelId } }` thay vì load hết message id |

**Ví dụ đúng — attachments theo channel:**

```typescript
await prisma.attachment.findMany({
  where: { message: { channelId } },
  take: limit,
  skip: (page - 1) * limit,
  orderBy: { createdAt: 'desc' }
})
```

**Ví dụ sai — load hết message id rồi mới query attachment:**

```typescript
const messages = await prisma.message.findMany({ where: { channelId }, select: { id: true } })
await prisma.attachment.findMany({ where: { messageId: { in: messageIds } } })
```

---

## 5. Build `Map` từ query — cẩn thận ghi đè

```typescript
// ❌ Cùng key → value sau ghi đè value trước (thường lấy bản CŨ nếu sort desc)
new Map(rows.map((r) => [r.channelId.toString(), r.id]))

// ✅ Chỉ set lần đầu (khi list đã sort createdAt desc)
const map = new Map<string, bigint>()
for (const row of rows) {
  const key = row.channelId.toString()
  if (!map.has(key)) map.set(key, row.id)
}
```

Hoặc dùng `DISTINCT ON` / subquery để DB trả đúng 1 row/group.

---

## 6. Batch query + chạy song song

```typescript
const [items, total] = await Promise.all([
  prisma.message.findMany({ where, take, skip }),
  prisma.message.count({ where })
])
```

Gom read state + last message:

```typescript
const [readStates, lastMessages] = await Promise.all([
  prisma.channelReadState.findMany({ where: { userId, channelId: { in: channelIds } } }),
  prisma.$queryRaw`SELECT DISTINCT ON (channel_id) ...`
])
```

---

## 7. Filter trong `where`, không filter sau query

```typescript
// ❌
const users = await prisma.user.findMany({ ... })
return users.filter((u) => u.id !== meId)

// ✅
await prisma.user.findMany({
  where: { id: { not: meId }, ... }
})
```

---

## 8. Deep nested `include` — cân nhắc tách API

```typescript
// ⚠️ Load hết workspace → categories → channels một lần
include: {
  categories: { include: { channels: true } }
}
```

**Khi workspace lớn:** tách API sidebar (metadata) vs detail (load theo nhu cầu).

---

## 9. Nested `create` hàng loạt

```typescript
// ⚠️ Workspace 500 member → 500 insert nickname khi create channel
nicknames: { create: nicknamesData }
```

**Gợi ý:** lazy create (khi user join / set nickname) hoặc `createMany` tách bước.

---

## 10. Index cột hay filter / sort

```prisma
@@index([channelId])
@@index([userId])
// Gợi ý thêm khi sort tin theo channel:
// messages(channel_id, created_at DESC)
```

Filter hoặc `orderBy` cột không có index → dễ full scan khi data lớn.

---

## 11. `$queryRaw` khi nào dùng

Dùng khi Prisma không express được hiệu quả:

- `DISTINCT ON` — latest message per channel
- `LATERAL JOIN` — gom nhiều bước thành 1 query
- Aggregate phức tạp

Luôn dùng `Prisma.join(array)` cho `IN (...)` — tránh SQL injection.

---

## 12. Denormalize khi read path quá nóng

Ví dụ unread DM sidebar gọi liên tục:

| Cách | Ghi chú |
|------|---------|
| Scan `messages` mỗi lần | Chậm khi nhiều tin |
| `DISTINCT ON` | Tốt cho giai đoạn hiện tại |
| `channel.lastMessageId` + `ChannelReadState` | Tốt dài hạn — update khi send message |

---

## Checklist trước khi merge service mới

```
□ Có loop + await prisma không?
□ select/include có field thừa hoặc password không?
□ List API có take/skip (hoặc cursor)?
□ findMany có kéo hết bảng trung gian không?
□ orderBy có đúng ý “1 row per group”?
□ Map/reduce có ghi đè sai không?
□ Filter có đưa vào where thay vì .filter() JS?
□ Cột filter/sort có index?
□ Có thể dùng relation filter thay vì 2 bước?
□ Response có omit password / field nhạy cảm?
```

---

## Case study trong project

| API | Vấn đề | Hướng xử lý |
|-----|--------|-------------|
| `getAttachmentsForChannel` | Load hết message id | Query `attachment` qua `message.channelId` |
| `getUnreadFriends` | Load hết messages DM | `DISTINCT ON (channel_id)` |
| `getMessagesForDM` | `sender: true` | `sender: { select: {...} }` |
| `getWorkspacesOfUser` | Deep nested include | Tách API / lazy load channels |
| `getAllFriends` | Không paginate | Thêm take/skip khi scale |
| `createChannel` | Bulk nickname theo workspace size | Lazy create nickname |

---

## Nguyên tắc cốt lõi

> **Ít query — ít row — đúng field — index đúng chỗ.**

Khi nghi ngờ, log số query (Prisma `$on('query')` dev) hoặc explain SQL trước khi ship API read-heavy.
