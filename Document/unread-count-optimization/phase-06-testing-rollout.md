# Phase 6: Testing & Rollout

> ⏱️ **Thời gian:** 1 giờ
> 🎯 **Mục tiêu:** Test toàn bộ hệ thống unread + checklist nghiệm thu trước production
> 📍 **Vị trí code:** Không thêm code (trừ khi fix được phát hiện)

---

## 🎯 Bối cảnh

Sau Phase 1–5, hệ thống unread đã đổi kiến trúc:

```
TRƯỚC:  FE tự cộng count += 1  (client-side state)
SAU:    Server tính count → Redis Hash là nguồn sự thật → emit per-user
```

Đây là thay đổi lớn → cần test kỹ trước khi lên production.

---

## 📋 Ma trận test tổng thể

### A. Tính count (server-authoritative)

| # | Tình huống | Setup | Kỳ vọng |
|---|---|---|---|
| A1 | 1 tin, user chưa đọc | A gửi 1 tin | count = 1 |
| A2 | 3 tin liên tiếp | A gửi 3 tin nhanh | count = 3 (không phải 1) |
| A3 | User đã đọc hết | B mở channel → A gửi 3 tin | count = 3 |
| A4 | User đọc 1 phần | B đọc 1 tin → A gửi 3 tin | count = 3 (đọc lúc đó không phải lúc gửi) |
| A5 | User đang mở channel | B mở channel X → A gửi 3 tin | count server = 3, badge FE = 0 |
| A6 | User rời channel | B rời channel X → A gửi 3 tin | count = 3 |
| A7 | Tin đến lúc user đang xem, rồi rời | B mở X → A gửi 3 → B rời X | count = 0 (đã đọc lúc rời) |
| A8 | Message CONFIG | Đổi setting channel | count không tăng |
| A9 | Channel chưa có message | Channel mới tạo | count = 0, `lastMessageId: null` |

### B. Emit & payload

| # | Tình huống | Kỳ vọng |
|---|---|---|
| B1 | Payload đầy đủ | `{ channelId, workspaceId, type, count, lastMessageId, senderId }` — 6 field, đúng tên |
| B2 | Kiểu dữ liệu | `channelId`, `workspaceId`, `lastMessageId`, `senderId` là **string**; `count` là **number** |
| B3 | Người gửi không nhận event | A gửi → A không nhận `channel_unread` |
| B4 | Dedup | Gửi lại cùng event 3 lần → badge không nhảy |
| B5 | User đang xem channel | Không có badge (FE tự filter) |
| B6 | DM | `workspaceId: null`, `type: 'DM'` |

### C. Read state

| # | Tình huống | Kỳ vọng |
|---|---|---|
| C1 | `join_channel` | Tạo/cập nhật `channel_read_states` với `lastReadMessageId` = message mới nhất |
| C2 | `leave_channel` | Cập nhật `channel_read_states` lúc rời |
| C3 | `join` rồi `leave` liên tiếp | Read state = message mới nhất tại lúc leave |
| C4 | User không phải member | `leave_channel` vẫn chạy (không throw) |

### D. REST `/channels/unread`

| # | Tình huống | Kỳ vọng |
|---|---|---|
| D1 | Có unread | `{ workspaceId, channelId, type, lastMessageId, count, unread: true }` |
| D2 | Không unread | `count: 0`, `unread: false` |
| D3 | `workspaceId` null (DM) | `null` (không phải `0` hay `undefined`) |
| D4 | Redis miss | Fallback DB → count đúng |
| D5 | Gọi 2 lần liên tiếp | Count giống nhau, không nhảy |

### E. Multi-instance

| # | Tình huống | Kỳ vọng |
|---|---|---|
| E1 | A ở instance 1, B ở instance 2 | B nhận event + count đúng |
| E2 | A gửi 5 tin, B offline | Redis counter = 5 cho B |
| E3 | B online lại (instance khác) | Badge = 5 |
| E4 | 2 instance cùng gửi vào 1 channel | Count đúng (không nhân đôi) |

### F. Redis failure

| # | Tình huống | Kỳ vọng |
|---|---|---|
| F1 | `FLUSHDB` | REST fallback DB → count đúng; ≤5 phút sau reconcile ghi lại |
| F2 | Redis down lúc gửi tin | Message **vẫn gửi thành công** (không crash); badge có thể trễ, reconcile sửa sau |
| F3 | Redis down lúc worker đọc | Job fail → BullMQ retry → không mất event |
| F4 | HSET sai giá trị | ≤5 phút → reconcile sửa về đúng |

---

## 🔧 Bộ test tự động (script debug)

Tạo file tạm `test-unread.js` ở root (xoá sau khi test):

```javascript
require('dotenv').config()
const { PrismaClient } = require('./src/generated/prisma/client')
const Redis = require('ioredis')

const prisma = new PrismaClient()
const redis = new Redis(process.env.REDIS_URL, { keyPrefix: 'chat:' })

async function main() {
  const channelId = process.argv[2] || '10'
  const userId = process.argv[3] || '15'

  console.log('=== Redis counter ===')
  console.log(await redis.hgetall(`unread:${channelId}`))

  console.log('\n=== Read state (DB) ===')
  console.log(await prisma.channelReadState.findMany({
    where: { channelId: BigInt(channelId), userId: BigInt(userId) }
  }))

  console.log('\n=== Count từ DB (cutoff) ===')
  const state = await prisma.channelReadState.findUnique({
    where: { userId_channelId: { userId: BigInt(userId), channelId: BigInt(channelId) } }
  })
  const count = await prisma.message.count({
    where: {
      channelId: BigInt(channelId),
      id: { gt: state?.lastReadMessageId ?? BigInt(0) },
      messageType: { not: 'CONFIG' }
    }
  })
  console.log('count =', count)

  console.log('\n=== Members ===')
  console.log(await prisma.channelMember.findMany({
    where: { channelId: BigInt(channelId) },
    select: { userId: true, status: true }
  }))

  await prisma.$disconnect()
  await redis.quit()
}

main().catch(console.error)
```

Chạy:

```bash
node test-unread.js 10 15
```

---

## 🔧 Test tự động với Socket.IO client

```javascript
// test-unread-socket.js
require('dotenv').config()
const { io } = require('socket.io-client')

const socket = io('http://localhost:5000', {
  auth: {
    Authorization: `Bearer ${process.env.ACCESS_TOKEN}`
  },
  transports: ['websocket']
})

socket.on('connect', () => {
  console.log('connected:', socket.id)
  socket.emit('join_channel', process.argv[2] || '10')
})

socket.on('channel_unread', (payload) => {
  console.log('=== channel_unread ===')
  console.log(JSON.stringify(payload, null, 2))
  console.log('field check:')
  console.log('  channelId (string):', typeof payload.channelId === 'string')
  console.log('  workspaceId:', payload.workspaceId)
  console.log('  type:', payload.type)
  console.log('  count (number):', typeof payload.count === 'number')
  console.log('  lastMessageId (string):', typeof payload.lastMessageId === 'string')
  console.log('  senderId (string):', typeof payload.senderId === 'string')
  process.exit(0)
})

setTimeout(() => {
  console.error('timeout — không nhận event')
  process.exit(1)
}, 30000)
```

---

## 📋 Checklist nghiệm thu từng phase

### Phase 1 — Server-authoritative count

- [ ] `src/queues/unread.types.ts` tồn tại, được import từ cả aggregator + worker
- [ ] `UnreadEvent.workspaceId` là `number | null`
- [ ] Worker dùng `getUnreadCounts` (cutoff grouping) — 1 query readState + N count theo cutoff
- [ ] Emit **riêng từng user** (`io.to(Socket_Room.user(...))`)
- [ ] Payload có đủ 6 field đúng tên FE
- [ ] `latestSenderId` = sender của message mới nhất
- [ ] REST dùng cùng công thức `id > lastReadMessageId`
- [ ] FE type `workspaceId: string | null`

### Phase 2 — Read state + DM

- [ ] `leave_channel` gọi `upsertChannelReadState`
- [ ] `handleSendMessage` / `handleSendGif` không còn `if (workspaceId === null) return`
- [ ] DM nhận event `channel_unread` với `workspaceId: null`, `type: 'DM'`

### Phase 3 — Redis counter

- [ ] `src/services/unread.services.ts` tồn tại
- [ ] `incrementUnreadBatch` gọi trong write path (sau `message.create`)
- [ ] `resetUnread` gọi trong `upsertChannelReadState` (sau upsert DB)
- [ ] Worker đọc `HMGET`, không query DB
- [ ] Redis bật AOF (`appendonly yes`)
- [ ] **Không** increment ở worker (tránh double count khi retry)

### Phase 4 — REST từ Redis

- [ ] `getUnreadCountForUser` có fallback DB
- [ ] `getUnreadChannel` dùng `groupBy` (không tải toàn bộ message)
- [ ] Response trả string tường minh
- [ ] REST count khớp badge socket

### Phase 5 — Reconcile

- [ ] `unread:active` ZSET được ghi khi có message
- [ ] `reconcileChannel` sửa count lệch
- [ ] Worker reconcile chạy mỗi 5 phút, chỉ 1 instance
- [ ] `shutdown()` đóng reconcile worker

---

## 📋 Rollout an toàn

### Deploy theo thứ tự

```
1. Deploy server (Phase 1–5 code) — CHƯA bật reconcile
   → Hệ thống vẫn đúng (DB là nguồn sự thật ở Phase 1-2, Redis ở Phase 3-4)

2. Bật reconcile (Phase 5)
   → Log "[Reconcile] done: N channels, M user(s) fixed"

3. Deploy FE (type workspaceId → string | null)
   → Hoặc deploy FE TRƯỚC server để không có lúc nào type lệch
```

> ⚠️ **Thứ tự an toàn:** deploy FE trước (chỉ đổi type, không đổi logic) → deploy server.

### Rollback

| Lỗi phát hiện | Cách rollback |
|---|---|
| Badge sai số | Tắt reconcile → kiểm tra lại logic count |
| Event không về | Kiểm tra BullMQ log → job có đang chạy không |
| Server crash | `docker restart` — dữ liệu Redis vẫn còn (AOF) |
| DB lỗi | Fallback đã xử lý; kiểm tra `channel_read_states` |

### Monitoring sau deploy

```bash
# Counter có đang tăng không
docker exec -it chat-redis redis-cli HGETALL chat:unread:10

# Job reconcile có chạy không (log server)
grep "\[Reconcile\]" server.log | tail -20

# Job có bị fail không
docker exec -it chat-redis redis-cli ZCARD bull:unread-reconcile:failed
```

### Log cần theo dõi

| Log | Ý nghĩa |
|---|---|
| `[Unread Worker] processed N events` | Worker đang chạy |
| `[Aggregator] flushed N events to 1 job` | Buffer đang được đẩy vào queue |
| `[Reconcile] channel X: fixed N user(s)` | Reconcile đang sửa lệch |
| `[Reconcile] done: N channels` | Reconcile hoàn tất 1 vòng |

---

## 🐛 Bảng lỗi tổng hợp

| Triệu chứng | Nguyên nhân phổ biến | Phase sửa |
|---|---|---|
| Badge luôn = 1 | Server gửi delta thay vì tổng | Phase 1 |
| Badge nhảy số giữa REST và socket | 2 công thức khác nhau | Phase 1 + 4 |
| Badge DM không hiện | `if (workspaceId === null) return` | Phase 2 |
| Badge tồn đọng sau khi đọc | `leave_channel` không update read state | Phase 2 |
| Count tăng 2 lần | Increment ở cả write path và worker | Phase 3 |
| Count = 0 sau khi restart Redis | Không bật AOF + chưa có reconcile | Phase 5 |
| Event về nhưng thiếu field | Đang dùng code cũ của worker | Phase 1 |
| `BigInt` lỗi serialize | Trả BigInt trực tiếp từ REST | Phase 4 |

---

## ✅ Checklist hoàn thành toàn bộ chuỗi Phase

- [ ] Phase 0: Đọc & chốt hướng
- [ ] Phase 1: Server-authoritative count
- [ ] Phase 2: Read state leave_channel + DM
- [ ] Phase 3: Redis counter
- [ ] Phase 4: REST từ Redis
- [ ] Phase 5: Reconcile job
- [ ] Phase 6: Test & rollout
- [ ] Deploy FE (type) → deploy server → bật reconcile
- [ ] Monitoring 24h sau deploy

---

## 📎 File tham khảo

- Worker: `src/queues/unread.worker.ts`
- Aggregator: `src/queues/unread.aggregator.ts`
- Types: `src/queues/unread.types.ts`
- Unread service: `src/services/unread.services.ts` (`getUnreadCounts`)
- Reconcile worker: `src/queues/reconcile.worker.ts`
- Redis cache: `src/services/redis.services.ts`
- Socket utils: `src/socket/utils.ts`
- REST service: `src/services/channel.services.ts` (`getUnreadChannel`)
- FE store: `client/src/store/unreadStore.ts`
- FE types: `client/src/types/channel.type.ts`
