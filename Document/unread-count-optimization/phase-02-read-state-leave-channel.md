# Phase 2: Read State khi Leave Channel + Mở DM

> ⏱️ **Thời gian:** 1–1.5 giờ
> 🎯 **Mục tiêu:** Badge không bị sai khi user đang mở channel; DM có badge unread
> 📍 **Vị trí code:** `src/socket/socket.ts` (`join_channel`/`leave_channel`), `src/socket/utils.ts` (`upsertChannelReadState`, `handleSendMessage`/`handleSendGif`), `src/services/redis.services.ts` (cache latest message), `src/services/unread.services.ts` (fix cutoff = 0)
> ✅ **Trạng thái:** Đã implement

---

## 🎯 Vấn đề 1: Read state chỉ cập nhật khi `join_channel`

Hiện tại `src/socket/socket.ts`:

```typescript
socket.on('join_channel', async (channel_id) => {
  ...
  socket.join(Socket_Room.channel(channelId))
  activeChannelId = channelId

  await upsertChannelReadState(userId, Number(channelId))   // ← chỉ ở đây
})

socket.on('leave_channel', async (channel_id) => {
  const channelId = channel_id.toString()
  if (activeChannelId === channelId) {
    activeChannelId = null
  }
  socket.leave(Socket_Room.channel(channelId))
  // ← KHÔNG cập nhật read state
})
```

### Kịch bản lỗi

```
t0: User mở channel A  → server set lastReadMessageId = 100
t1: A gửi 5 tin mới (101..105) → count(user) = 5
    FE markUnread bỏ qua (vì channelId === currentOpenId) → badge A không hiện  ← OK tạm
t2: User chuyển sang channel B → FE markReadOptimistic(A) → XOÁ entry A → badge A = 0
t3: Nhưng SERVER vẫn nghĩ user A có 5 tin chưa đọc (lastReadMessageId = 100)
t4: A gửi thêm 1 tin (106) → server count = 6 → FE set badge A = 6
    → User thấy "6 tin chưa đọc" trong khi thực tế đã đọc 5 tin lúc t2  ❌
```

**Nguyên nhân gốc:** read state chỉ được snapshot **lúc vào** channel, không được snapshot **lúc rời**. Tin đến trong lúc user đang xem bị tính là chưa đọc vĩnh viễn.

### Cách sửa: chốt read state ở CẢ 2 mốc

```typescript
socket.on('join_channel', async (channel_id) => {
  const channelId = channel_id.toString()
  const isMember = await isMemberChannel(userId, Number(channelId))
  if (!isMember) return

  // RỜI channel CŨ → chốt read state cho channel cũ
  if (activeChannelId && activeChannelId !== channelId) {
    socket.leave(Socket_Room.channel(activeChannelId))
    await upsertChannelReadState(userId, Number(activeChannelId))
  }

  socket.join(Socket_Room.channel(channelId))
  activeChannelId = channelId

  await upsertChannelReadState(userId, Number(channelId))
})

socket.on('leave_channel', async (channel_id) => {
  const channelId = channel_id.toString()

  // Chỉ chốt read state nếu đây là channel user ĐANG xem
  if (activeChannelId === channelId) {
    activeChannelId = null
    await upsertChannelReadState(userId, Number(channelId))
  }

  socket.leave(Socket_Room.channel(channelId))
})
```

### Vì sao cần chốt ở CẢ 2 nơi (không chỉ 1)?

Vì **thứ tự emit từ client không đảm bảo**. Client hiện tại (React `useEffect` cleanup) emit `leave_channel` khi đổi channel:

```typescript
// client/src/Hooks/useChannelSocket.tsx
return () => {
  ...
  if (socket.connected) {
    socket.emit("leave_channel", channelId);
  }
};
```

Nhưng có 2 thứ tự khả dĩ:

| Thứ tự | Không chốt ở `join` | Không chốt ở `leave` | Chốt cả 2 ✓ |
|---|---|---|---|
| `leave(A)` → `join(B)` | ✓ (leave chốt A) | ✗ (join B chỉ chốt B, A bị sót) | ✓ |
| `join(B)` → `leave(A)` | ✗ (join B không chốt A) | ✓ (leave A chốt A) | ✓ |

→ **Chốt ở cả 2 nơi** → không phụ thuộc thứ tự emit.

### Điều kiện `activeChannelId` chống chống trùng

```typescript
// join: chỉ chốt channel cũ nếu khác channel mới
if (activeChannelId && activeChannelId !== channelId) { ... }

// leave: chỉ chốt nếu đây là channel đang xem
if (activeChannelId === channelId) { ... }
```

→ Mỗi lần chuyển channel chỉ chốt **1 lần** → không lãng phí query DB.

Sau khi sửa:
```
t0: User mở channel A → lastRead = 100
t1: A gửi 5 tin (101..105) → count = 5, FE bỏ qua (đang xem) → badge A = 0  ✓
t2: User rời A → chốt read state → lastRead = 105 → count = 0  ✓
t3: A gửi thêm tin (106) → count = 1 → badge A = 1  ✓  (đúng: 106 chưa đọc)
```

---

## 🎯 Vấn đề 2: Channel DM không bao giờ có unread

### Hiện tại

`src/socket/utils.ts` → `handleSendMessage`:

```typescript
const workspaceId = await getChannelWorkspaceId(channelId.toString())
if (workspaceId === null) return   // ← DM bị skip ở đây
```

`getChannelWorkspaceId` trả `null` cho channel DM vì DM channel được tạo **không có `workspaceId`**:

```typescript
// src/services/friend.services.ts
await databaseServices.prisma.channel.create({
  data: {
    name: 'Direct Messages',
    type: ChannelType.DM,
    description: 'Phòng chat riêng tư',
    isPrivate: true,
    // ← không có workspaceId
```

### Hậu quả

- DM **không bao giờ** đẩy event unread → FE không bao giờ hiện badge DM.
- Nhưng FE **có** badge DM: `countUnreadChannelDM` trong `unreadStore.ts`.

```typescript
// client/src/store/unreadStore.ts
function getCountUnreadChannelDM(data: Map<string, ChannelUnread>) {
  let count = 0;
  for (const value of data.values()) {
    if (value.type === ChannelType.DM && value.workspaceId === null) {
      count += value.count;
    }
  }
  return count;
}
```

→ Đặc tả FE đã hỗ trợ DM, nhưng server không gửi → **tính năng chết**.

### Cách sửa

Bỏ early return, cho phép `workspaceId = null` đi tiếp:

```typescript
// workspaceId = null → channel DM (không thuộc workspace nào).
// KHÔNG return sớm: DM vẫn phải có badge unread như các channel khác.
const workspaceId = await getChannelWorkspaceId(channelId.toString())

const channelType = await getChannelType(channelId.toString())
if (channelType === null) return

enqueueUnread({
  channelId,
  workspaceId,   // ← number | null
  senderId: userId,
  messageId: Number(res.id),
  createdAt: new Date().toISOString(),
  type: channelType
}).catch((err) => console.error('[enqueueUnread]', err))
```

Làm tương tự cho `handleSendGif`.

### Thay đổi lan toả

| File | Thay đổi |
|---|---|
| `src/queues/unread.types.ts` | `UnreadEvent.workspaceId: number \| null` (Phase 1 đã làm) |
| `src/queues/unread.worker.ts` | `ChannelGroup.workspaceId: number \| null` (Phase 1 đã làm) |
| `src/socket/utils.ts` | Bỏ `if (workspaceId === null) return` |
| `client/src/types/channel.type.ts` | `workspaceId: string \| null` (Phase 1 đã làm) |

### Worker tự xử lý DM

Worker **không** dùng `group.workspaceId` để quyết định gì — nó chỉ map thẳng:

```typescript
workspaceId: group.workspaceId === null ? null : String(group.workspaceId),
```

→ DM nhận `workspaceId: null`, `type: 'DM'` → FE `getCountUnreadChannelDM` check `workspaceId === null` → **khớp**.

---

## 🎯 Vấn đề 3: Cutoff phải bỏ qua message CONFIG

Đây là bug tiềm ẩn trong `upsertChannelReadState` — lộ ra khi chốt read state ở `leave_channel`.

### Công thức count

```
count(user) = COUNT(messages WHERE id > cutoff AND messageType != 'CONFIG')
```

### Vấn đề

`upsertChannelReadState` lấy message mới nhất **không lọc CONFIG**:

```typescript
// ❌ TRƯỚC
const latestMessageId = (
  await databaseServices.prisma.message.findFirst({
    where: { channelId },              // ← không loại CONFIG
    orderBy: { id: 'desc' },
    select: { id: true }
  })
)?.id
```

Kịch bản lỗi:

```
t0: message thật id 100 (user chưa đọc)
t1: admin đổi nickname → tạo message CONFIG id 101
t2: user mở channel → cutoff = 101 (do lấy message mới nhất)
t3: count = COUNT(id > 101 AND type != CONFIG) = 0
    → Message 100 bị coi là ĐÃ ĐỌC dù user chưa từng thấy  ❌
```

→ Mất badge của message thật gần nhất.

### Cách sửa

```typescript
// ✅ SAU
const latestMessageId = (
  await databaseServices.prisma.message.findFirst({
    where: { channelId, messageType: { not: MessageType.CONFIG } },
    orderBy: { id: 'desc' },
    select: { id: true }
  })
)?.id
```

Sau khi sửa: cutoff = 100 → count = COUNT(id > 100) = 1 ✓

---

## 🔧 Bước 4: Tối ưu `upsertChannelReadState` — 2 query → 1 query

Sau Phase 2, `upsertChannelReadState` được gọi ở **cả join + leave** → mỗi lần chuyển channel là 2 query DB.

### Thêm cache Redis cho message mới nhất

`src/services/redis.services.ts`:

```typescript
const LATEST_MESSAGE_TTL = 300 // 5 phút

export const getChannelLatestMessageId = async (channelId: string): Promise<bigint | null> => {
  const key = `channel:${channelId}:latestMessage`

  // 1. Thử cache
  const cached = await redis.get(key)
  if (cached !== null) {
    return BigInt(cached)
  }

  // 2. Cache miss → query DB
  const message = await databaseServices.prisma.message.findFirst({
    where: {
      channelId: BigInt(channelId),
      messageType: { not: 'CONFIG' }
    },
    orderBy: { id: 'desc' },
    select: { id: true }
  })
  if (!message) return null

  // 3. Ghi cache (set + expire atomic)
  await redis.set(key, message.id.toString(), 'EX', LATEST_MESSAGE_TTL)

  return message.id
}

export const invalidateChannelLatestMessage = async (channelId: string | number): Promise<void> => {
  await redis.del(`channel:${String(channelId)}:latestMessage`)
}
```

### Dùng trong `upsertChannelReadState`

```typescript
const latestMessageId =
  lastReadMessageId ??
  (await getChannelLatestMessageId(channelId.toString()))
```

→ Chỉ còn **1 query DB** (upsert read state).

### Invalidate cache khi có message mới

**Bắt buộc** — nếu không, cache sẽ trả message cũ → chốt read state sai:

```typescript
// src/socket/utils.ts — handleSendMessage
await invalidateChannelLatestMessage(channelId)

// src/socket/utils.ts — handleSendGif
await invalidateChannelLatestMessage(channelId)
```

> ⚠️ TTL 5 phút là "lưới an toàn", nhưng **invalidate chủ động** mới là đảm bảo chính xác.

---

## 🎯 Vấn đề 4: User chưa có read state → count luôn = 0

Bug trong `getUnreadCounts` (Phase 1) — chỉ lộ ra khi user mới vào channel lần đầu.

### Nguyên nhân

```typescript
// 2. Map userId → cutoff
const cutoffMap = new Map<number, bigint>()
for (const state of readStates) {          // ← chỉ có user CÓ read state
  cutoffMap.set(Number(state.userId), state.lastReadMessageId ?? BigInt(0))
}

// 3. Gom distinct cutoff
const cutoffs = new Set<string>()
for (const cutoff of cutoffMap.values()) {   // ← '0' KHÔNG có trong set
  cutoffs.add(cutoff.toString())
}
```

User chưa có read state → không có trong `cutoffMap` → **`'0'` không có trong `cutoffs`** → không có count query cho cutoff 0.

```typescript
// 5. Trả về map
const cutoff = cutoffMap.get(userId) ?? BigInt(0)     // → 0
result.set(userId, countByCutoff.get('0') ?? 0)        // → undefined ?? 0 = 0  ❌
```

→ User mới vào channel lần đầu **luôn thấy count = 0**, dù channel có 50 tin chưa đọc.

### Cách sửa

Thêm user chưa có read state vào `cutoffMap` **trước** khi gom distinct cutoff:

```typescript
// 2. Map userId → cutoff (user chưa có read state → cutoff = 0 → count = toàn bộ message)
const cutoffMap = new Map<number, bigint>()
for (const state of readStates) {
  cutoffMap.set(Number(state.userId), state.lastReadMessageId ?? BigInt(0))
}

// User KHÔNG có read state (chưa vào channel lần nào) → cutoff = 0.
// Phải thêm vào cutoffMap TRƯỚC khi gom distinct cutoff, nếu không:
//   - '0' không có trong `cutoffs` → không có count query cho cutoff 0
//   → countByCutoff.get('0') = undefined → count = 0 (SAI, phải là toàn bộ message)
for (const userId of userIds) {
  if (!cutoffMap.has(userId)) {
    cutoffMap.set(userId, BigInt(0))
  }
}
```

→ Giờ `'0'` có trong `cutoffs` → có count query cho cutoff 0 → count = tổng số message ✓

> REST `getUnreadChannel` đã đúng sẵn vì dùng `readChannelState?.lastReadMessageId ?? BigInt(0)` **ngay tại chỗ tính count** → không qua bước gom cutoff.

---

## 🎯 Vấn đề 5: FE tự filter — không cần sửa

```typescript
// client/src/store/unreadStore.ts
markUnread: (payload: ChannelUnreadPayload) => {
  const currentOpenId = useChannelStore.getState().channelId;
  const currentUserId = useUserStore.getState().user?.id;
  if (payload.channelId === currentOpenId) return; // đang xem -> bỏ
  if (payload.senderId === currentUserId) return;  // tự gửi -> bỏ
  ...
}
```

**Đánh giá:**
- `payload.senderId === currentUserId` → **đúng**, giữ nguyên.
- `payload.channelId === currentOpenId` → **đúng về ý nghĩa**. Sau fix Phase 2, server đã chốt read state ở `leave_channel` nên **không còn lệch** giữa server và FE.

**Tương tác với fix Phase 2:**

| Thời điểm | Server count | FE badge |
|---|---|---|
| Tin đến lúc user đang xem | > 0 | 0 (FE bỏ qua) ✓ |
| User rời channel | 0 (đã chốt read state) | 0 ✓ |
| Tin mới sau khi rời | 1 | 1 ✓ |

→ **Không cần sửa FE logic.**

### Tuỳ chọn nâng cao: server bỏ qua user đang xem channel

Có thể cho server biết user nào đang mở channel nào → worker skip → tiết kiệm emit:

```typescript
socket.join(Socket_Room.viewingChannel(userId))
```

Worker check user đó có trong room không → skip. Nhưng phức tạp hơn, **chưa cần** ở scale hiện tại.

---

## 📊 Đánh giá

| | Trước | Sau |
|---|---|---|
| Read state khi rời channel | ❌ không cập nhật | ✅ chốt ở join + leave |
| Phụ thuộc thứ tự emit client | ❌ | ✅ không |
| Badge DM | ❌ chết | ✅ hoạt động |
| Cutoff trỏ vào message CONFIG | ❌ mất badge | ✅ bỏ qua CONFIG |
| Query DB / join hoặc leave | 2 | **1** (cache latest message) |
| Count của user chưa vào channel lần đầu | ❌ luôn 0 | ✅ tổng số message |

---

## 🐛 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|---|---|---|
| Badge không về 0 sau khi rời channel | Chưa chốt read state ở `leave_channel` | Thêm `upsertChannelReadState` |
| Chốt 2 lần cho 1 lần chuyển channel | Thiếu điều kiện `activeChannelId` | Giữ điều kiện trong doc |
| Badge DM không hiện | `if (workspaceId === null) return` | Bỏ early return |
| Mất badge message gần nhất | Cutoff trỏ vào message CONFIG | Lọc `messageType: { not: CONFIG }` |
| Count luôn 0 cho user mới | Thiếu user chưa có read state trong `cutoffMap` | Thêm vòng `for` trước bước gom cutoff |
| Read state chốt sai (thiếu tin mới) | Cache `latestMessage` chưa invalidate | Gọi `invalidateChannelLatestMessage` sau khi tạo message |
| `PrismaClientValidationError` | `BigInt(channelId)` với channelId không hợp lệ | Guard `Number.isInteger` |

---

## ✅ Checkpoint Phase 2

- [x] `leave_channel` gọi `upsertChannelReadState` (có điều kiện `activeChannelId === channelId`)
- [x] `join_channel` chốt read state cho channel cũ (trước khi switch)
- [x] `handleSendMessage` / `handleSendGif` bỏ `if (workspaceId === null) return`
- [x] `upsertChannelReadState` lọc `messageType: { not: CONFIG }`
- [x] Cache `channel:{id}:latestMessage` trong `redis.services.ts`
- [x] `invalidateChannelLatestMessage` gọi sau khi tạo message
- [x] `getUnreadCounts` thêm user chưa có read state vào `cutoffMap` (cutoff = 0)
- [x] FE type `workspaceId: string | null` (Phase 1 đã làm)
- [x] TypeScript compile không lỗi

### Test ma trận

| Tình huống | Kỳ vọng |
|---|---|
| A mở channel X, B gửi 3 tin, A rời channel | Badge X = 0 (A đã đọc) |
| A không mở channel X, B gửi 3 tin | Badge X = 3 |
| A gửi tin cho B trong DM | B có badge DM = 1 |
| A tự gửi tin | A không có badge |
| B gửi 3 tin, A mở app (chưa vào channel) | Badge X = 3 |
| User mới vào channel lần đầu, channel có 5 tin cũ | Count = 5 (chưa đọc tin nào) |
| Admin đổi setting (CONFIG) rồi user mở channel | Message thật gần nhất vẫn tính là chưa đọc |
| Client emit `join(B)` rồi `leave(A)` | Read state A được chốt đúng 1 lần |
| Client emit `leave(A)` rồi `join(B)` | Read state A được chốt đúng 1 lần |

---

## 🔜 Phase tiếp theo

**[Phase 3: Redis Unread Counter (HINCRBY) →](./phase-03-redis-unread-counter.md)**

Phase 3 chuyển nguồn sự thật của `count` từ DB sang Redis Hash → đường nóng 0 query DB.
