# Kiến trúc Socket hiện tại — Phân tích chi tiết & Nhược điểm

> **Mục đích:** Mô tả chính xác cách hệ thống Socket.IO đang vận hành trong `Project-Fullstack/server`, chỉ ra các bottlenecks khi scale, làm nền tảng để hiểu giải pháp Redis ở file `redis-realtime-optimization.md`.
> **Đối tượng:** Dev mới onboard, technical writer, reviewer.
> **Ngày cập nhật:** 2026-10-17

---

## Mục lục

1. [Tổng quan hệ thống](#1-tổng-quan-hệ-thống)
2. [Các thành phần chính](#2-các-thành-phần-chính)
3. [Luồng hoạt động chi tiết](#3-luồng-hoạt-động-chi-tiết)
4. [Mô hình Room đang dùng](#4-mô-hình-room-đang-dùng)
5. [Cấu trúc dữ liệu In-Memory](#5-cấu-trúc-dữ-liệu-in-memory)
6. [Vòng đời một Message](#6-vòng-đời-một-message)
7. [Nhược điểm & Bottlenecks](#7-nhược-điểm--bottlenecks)
8. [Kịch bản thực tế gây lỗi](#8-kịch-bản-thực-tế-gây-lỗi)
9. [Tóm tắt vấn đề](#9-tóm-tắt-vấn-đề)

---

## 1. Tổng quan hệ thống

### 1.1. Stack công nghệ hiện tại

| Thành phần | Công nghệ | Phiên bản | Vai trò |
|------------|-----------|-----------|---------|
| Runtime | Node.js | (Express 5.x) | HTTP server |
| Realtime | Socket.IO | ^4.8.3 | WebSocket transport |
| ORM | Prisma | ^7.9.0 | Truy vấn DB |
| DB | MySQL / PostgreSQL | (qua Prisma adapter) | Persistent storage |
| Presence | In-memory `Map` | Native JS | Track user online |
| Auth | JWT (access + refresh) | `jsonwebtoken` | Xác thực socket |
| Upload | Formidable + AWS S3 | — | Attachment |

### 1.2. Sơ đồ tổng quan

```
┌─────────────────┐
│  React Client   │
│  (5173)         │
└────────┬────────┘
         │ WebSocket + JWT
         ▼
┌────────────────────────────────────────┐
│         Node.js Single Instance        │
│  ┌──────────────────────────────────┐  │
│  │  Socket.IO Server (port ?)       │  │
│  │  ┌────────────────────────────┐  │  │
│  │  │  Middleware: verify JWT    │  │  │
│  │  └────────────────────────────┘  │  │
│  │  ┌────────────────────────────┐  │  │
│  │  │  Connection Handler        │  │  │
│  │  │  - join_channel            │  │  │
│  │  │  - send_message            │  │  │
│  │  │  - send_gif                │  │  │
│  │  └────────────────────────────┘  │  │
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │  In-Memory State                 │  │
│  │  ┌────────────────────────────┐  │  │
│  │  │ Map<userId, Set<socketId>>  │  │  │
│  │  │ Map<socketId, userId>       │  │  │
│  │  └────────────────────────────┘  │  │
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │  Prisma Client                   │  │
│  └──────────────────────────────────┘  │
└────────┬───────────────────────────────┘
         │
         ▼
   ┌──────────────┐
   │  Database    │
   │  (MySQL)     │
   └──────────────┘
```

---

## 2. Các thành phần chính

### 2.1. `src/socket/socket.ts` — Khởi tạo Server

```typescript
// Khởi tạo Socket.IO server với CORS
io = new Server(httpSocket, {
  cors: {
    origin: ['http://localhost:5173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
})

// Middleware xác thực JWT (chạy 1 lần khi handshake)
io.use(async (socket, next) => {
  // Lấy access_token từ handshake.auth
  // Lấy refresh_token từ cookie
  // verifyAccessToken → decode payload
  // Gắn vào socket.handshake.auth
})

// Socket-level middleware (chạy cho mỗi packet)
socket.use(async (_, next) => {
  // verifyAccessToken mỗi packet
  // Nếu expired → gọi handleRefreshToken
})

// Handler connection
io.on('connection', async (socket) => {
  // Join user room
  // Join tất cả workspace rooms
  // Đăng ký các event: join_channel, send_message, send_gif, disconnect
})
```

### 2.2. `src/socket/utils.ts` — Business logic realtime

Chứa 4 hàm chính:

| Hàm | Mục đích | Side effects |
|-----|----------|--------------|
| `upsertChannelReadState` | Cập nhật trạng thái đã đọc | 1 query `findFirst` + 1 `upsert` |
| `emitUnreadChannel` | Báo unread cho members không ở channel | 2 query + N lần `io.to().emit()` tuần tự |
| `handleSendMessage` | Xử lý gửi message | 1-2 query + 2 emit + 1 async unread |
| `handleSendGif` | Xử lý gửi GIF | 1 query + 2 emit + 1 async unread |

### 2.3. `src/socket/online-users.ts` — In-memory presence

```typescript
const userSockets = new Map<UserId, Set<SocketId>>()      // user → sockets
const socketToUser = new Map<SocketId, UserId>()          // socket → user

addSocket(userId, socketId)       // Track khi connect
removeSocket(socketId)            // Track khi disconnect
getSocketIds(userId)              // Lấy tất cả socket của user
```

**Đặc điểm:** 2 `Map` song song để tra cứu 2 chiều O(1), cleanup theo socketId.

### 2.4. `src/socket/socket.ts` — Event handlers

| Event | Mục đích | Logic |
|-------|----------|-------|
| `join_channel` | User mở channel | Leave channel cũ, join channel mới, upsert read state |
| `leave_channel` | User rời channel | Leave room channel |
| `send_message` | Gửi tin nhắn text + file | Tạo message DB, emit `receive_message` + `channel_unread` |
| `send_gif` | Gửi GIF | Tạo message + attachment, emit `receive_message` + `receive_attachments` |
| `disconnect` | User ngắt kết nối | Xóa khỏi presence map |

---

## 3. Luồng hoạt động chi tiết

### 3.1. User kết nối lần đầu

```
Client                    Socket.IO Server              In-Memory
  │                              │                          │
  │ ── handshake + JWT ────────► │                          │
  │                              │ io.use verify JWT        │
  │                              │ (1 lần)                  │
  │ ◄── connection ack ───────── │                          │
  │                              │                          │
  │                              │ addSocket(userId, sid)──►│
  │                              │                          │
  │                              │ socket.join("user:15")   │
  │                              │ socket.join("workspace:1")│
  │                              │ socket.join("workspace:2")│
  │                              │                          │
  │                              │ (workspaceMembers        │
  │                              │  query DB)               │
  │                              │                          │
```

**Số DB query:** 2 (1 lookup `workspaceMember`, 1 verify JWT — JWT verify có thể thêm nếu blacklist check).

### 3.2. User mở channel

```
Client              Server                  In-Memory              DB
  │                   │                          │                  │
  │ join_channel(10)  │                          │                  │
  │ ─────────────────► │                          │                  │
  │                   │ if activeChannelId:       │                  │
  │                   │   socket.leave("ch:5")    │                  │
  │                   │                          │                  │
  │                   │ socket.join("ch:10")      │                  │
  │                   │ activeChannelId = 10      │                  │
  │                   │                          │                  │
  │                   │ upsertChannelReadState ────────────────────►│
  │                   │   - findFirst message     │                  │
  │                   │   - upsert read state     │                  │
  │                   │                          │                  │
```

**Số DB query:** 2 (findFirst + upsert).

### 3.3. User gửi message (kèm file)

```
Client              Server                         DB              Other Clients
  │                   │                              │                    │
  │ send_message      │                              │                    │
  │ {channel:10,      │                              │                    │
  │  content:"hi",    │                              │                    │
  │  files:[...]}     │                              │                    │
  │ ─────────────────► │                              │                    │
  │                   │ prisma.message.create() ─────►│                    │
  │                   │                              │ insert             │
  │                   │ ◄── message w/ sender ───────│                    │
  │                   │                              │                    │
  │                   │ prisma.attachment            │                    │
  │                   │   .createManyAndReturn() ───►│                    │
  │                   │ ◄── attachments[] ───────────│                    │
  │                   │                              │                    │
  │                   │ io.to("ch:10").emit(                               │
  │                   │   "receive_attachments", ──────────────────────►  │
  │                   │   attachments)                                    │
  │                   │                                                    │
  │                   │ io.to("ch:10").emit(                               │
  │                   │   "receive_message", ───────────────────────────►  │
  │                   │   {message, attachments})                          │
  │                   │                                                    │
  │                   │ emitUnreadChannel()                                │
  │                   │   - prisma.channel.findUnique() ───►DB             │
  │                   │   - prisma.channelMember.findMany() ─►DB           │
  │                   │   - for each member (except sender):               │
  │                   │       io.to("user:N").emit("channel_unread",...)  │
  │                   │                                                    │
  │                   │ ◄── await DB responses                            │
  │                   │                                                    │
```

**Số DB query:** 4 (1 message + 1 attachments + 1 channel find + 1 channelMember findMany).
**Số Socket emit:** 2 + N (N = số members trong channel trừ sender).

### 3.4. User disconnect

```
Server                    In-Memory
  │                           │
  │ socket disconnect        │
  │ ────────────────────────► │
  │                           │ removeSocket(socketId)
  │                           │   - lookup userId
  │                           │   - xóa khỏi Set
  │                           │   - nếu Set rỗng → xóa key
```

**Số DB query:** 0 (cleanup thuần in-memory).

---

## 4. Mô hình Room đang dùng

### 4.1. Các loại room

```typescript
export const Socket_Room = {
  user: (userId: string)       => `user:${userId}`,
  workspace: (workspaceId: string) => `workspace:${workspaceId}`,
  channel: (channelId: string)  => `channel:${channelId}`
}
```

### 4.2. Khi nào join room nào?

| Sự kiện | Room join | Ghi chú |
|---------|-----------|---------|
| Kết nối thành công | `user:<userId>` | Luôn join |
| Kết nối thành công | `workspace:<workspaceId>` (nhiều) | Join tất cả workspace user là member |
| `join_channel` event | `channel:<channelId>` | **Chỉ 1 channel tại 1 thời điểm** |
| `leave_channel` event | Leave `channel:<channelId>` | Cleanup |

### 4.3. Mục đích của từng room

| Room | Mục đích | Event emit tới |
|------|----------|----------------|
| `user:<userId>` | Notification cá nhân, unread, call, friend request | `channel_unread`, `friend_request`, `call_invitation`, `token_refresh` |
| `workspace:<workspaceId>` | Sự kiện cấu trúc workspace | `channel_created`, `member_joined`, `role_changed` |
| `channel:<channelId>` | Realtime nội dung đang mở | `receive_message`, `receive_attachments` |

### 4.4. Quy tắc quan trọng (từ `socket-room-policy.md`)

- ✅ `channel` chỉ lo nội dung đang xem
- ✅ `user` chỉ lo notification cá nhân
- ✅ `workspace` chỉ lo state cấp cao
- ✅ Unread cuối cùng vẫn tính từ DB, socket chỉ là tín hiệu

---

## 5. Cấu trúc dữ liệu In-Memory

### 5.1. Presence Map

```typescript
// userSockets: UserId → Set<SocketId>
userSockets = Map {
  "15" => Set { "abc123", "def456" },    // user 15 mở 2 tab
  "20" => Set { "xyz789" }
}

// socketToUser: SocketId → UserId (đảo ngược để cleanup)
socketToUser = Map {
  "abc123" => "15",
  "def456" => "15",
  "xyz789" => "20"
}
```

**Mục đích:** Tra cứu 2 chiều O(1).
- Cần biết user nào → dùng `userSockets.get(userId)`.
- Cần biết user nào khi disconnect → dùng `socketToUser.get(socketId)`.

### 5.2. Socket.IO internal rooms

Socket.IO tự quản lý rooms trong memory của nó:
- `socket.rooms` là Set các room mà socket đang tham gia.
- `io.sockets.adapter.rooms` là Map toàn bộ rooms.
- Khi gọi `io.to(room)`, nó duyệt Map này.

**Cảnh báo:** Các Map này CŨNG là in-memory, mất khi restart.

---

## 6. Vòng đời một Message

### 6.1. Sequence diagram đầy đủ

```
┌────────┐     ┌────────┐     ┌────────┐     ┌──────┐     ┌────────┐
│Sender  │     │Server  │     │   DB   │     │Redis │     │Others  │
│Client  │     │  Node  │     │ MySQL  │     │(none)│     │Clients │
└───┬────┘     └───┬────┘     └───┬────┘     └───┬──┘     └───┬────┘
    │              │              │              │            │
    │ send_message │              │              │            │
    │ ────────────►│              │              │            │
    │              │ INSERT msg   │              │            │
    │              │ ────────────►│              │            │
    │              │ ◄──── id ────│              │            │
    │              │              │              │            │
    │              │ INSERT attach (N)            │            │
    │              │ ────────────►│              │            │
    │              │ ◄──── arr ───│              │            │
    │              │              │              │            │
    │              │ emit receive_attachments    │            │
    │              │ ────────────────────────────────────────►│
    │              │              │              │            │
    │              │ emit receive_message (full)            │
    │              │ ────────────────────────────────────────►│
    │              │              │              │            │
    │              │ SELECT channel.workspaceId │            │
    │              │ ────────────►│              │            │
    │              │ ◄──── 5 ─────│              │            │
    │              │              │              │            │
    │              │ SELECT channelMember (N)   │            │
    │              │ ────────────►│              │            │
    │              │ ◄──── [...] ─│              │            │
    │              │              │              │            │
    │              │ for each member (sequential):            │
    │              │   io.to("user:N").emit(unread)          │
    │              │ ────────────────────────────────────────►│
    │              │              │              │            │
```

### 6.2. Đếm operation

Với 1 message text (không file), trong channel có 100 members, sender không nhận lại:

| Operation | Số lượng | Latency ước tính |
|-----------|----------|------------------|
| INSERT message | 1 | ~5ms |
| SELECT channel.workspaceId | 1 | ~2ms |
| SELECT channelMember | 1 | ~10ms (table scan nếu thiếu index) |
| emit receive_message | 1 broadcast → ~99 clients | ~5-50ms (tùy network) |
| emit channel_unread (loop tuần tự) | 99 lần | ~50-200ms |

**Tổng latency:** ~70-250ms cho 1 message — chấp nhận được.

**NHƯNG** khi 100 messages/phút từ nhiều user → DB connection pool cạn kiệt.

---

## 7. Nhược điểm & Bottlenecks

### 7.1. 🔴 Nhược điểm nghiêm trọng (Critical)

#### N1. In-Memory Presence không scale ngang

**Triệu chứng:** Chạy 1 instance OK, 2+ instance là user online bị "mất tích" qua lại.

**Nguyên nhân:**
- `Map<UserId, Set<SocketId>>` nằm trong memory riêng của mỗi process.
- User connect vào instance A, gửi message từ instance B → instance B không biết user có socket ở instance A.
- `io.to('user:15').emit(...)` chỉ emit cho socket ở CÙNG instance.

**Code vi phạm:** `src/socket/online-users.ts` toàn bộ file.

#### N2. Mất state khi restart

**Triệu chứng:** Deploy code → tất cả user bị "force disconnect" trải nghiệm.

**Nguyên nhân:**
- `userSockets` Map biến mất khi process chết.
- Client phải reconnect, re-join rooms.
- Mất `activeChannelId` → user phải re-emit `join_channel`.

#### N3. N+1 query cho unread notification

**Triệu chứng:** Channel lớn (1000+ members) → mỗi message trigger query lớn.

**Code vi phạm:** `emitUnreadChannel` (utils.ts:51-84):
```typescript
// 1 query để biết workspaceId
const channel = await prisma.channel.findFirst(...)
// 1 query để lấy members
const members = await prisma.channelMember.findMany(...)
// Loop tuần tự
for (const member of members) {
  io.to(...).emit(...)  // ← chậm khi N=1000
}
```

**Tác động:** Channel 1000 members × 10 msg/phút = 10,000 query/phút chỉ cho unread.

#### N4. Emit tuần tự trong loop

**Triệu chứng:** Latency `send_message` tăng theo số members.

**Code vi phạm:** `for (const member of members) { io.to(...).emit(...) }`.

**Tác động:** 1000 members × 0.5ms = 500ms blocking event loop.

#### N5. `upsertChannelReadState` mỗi lần join channel

**Triệu chứng:** User mở channel → 2 query (findFirst + upsert).

**Code vi phạm:** `upsertChannelReadState` được gọi trong handler `join_channel`.

**Tác động:** User chat nhanh qua nhiều channel → DB write storm.

### 7.2. 🟡 Nhược điểm trung bình (Medium)

#### M1. Không có backpressure

Nếu 1 client chậm, `io.to(socket).emit()` vẫn push packet → memory tăng.

**Thiếu:** Cơ chế `socket.disconnect()` khi client không ack sau N giây.

#### M2. Không có rate limit cho socket events

User spam `send_message` 100 lần/giây → 100 INSERT, không có rate limit.

**Thiếu:** `socket.use()` middleware check rate.

#### M3. JWT verify mỗi packet

`socket.use(async (_, next) => { await verifyAccessToken(...) })` chạy cho MỖI packet nhận được.

**Tác động:** Verify JWT tốn ~0.1-0.5ms × số packet/s = lãng phí CPU.

**Cải thiện:** Verify 1 lần ở connection, tin tưởng socket trong session.

#### M4. Không có message ordering guarantee

Nếu user gửi 5 message liên tiếp, server có thể xử lý theo thứ tự bất kỳ.

**Thiếu:** Client gửi kèm `client_msg_id` và server sắp xếp.

#### M5. Không có replay khi reconnect

Khi reconnect, user mất các message emit trong lúc disconnect.

**Thiếu:** Server-side queue để replay khi reconnect.

### 7.3. 🟢 Nhược điểm nhỏ (Minor)

#### m1. `console.log` rải rác

```typescript
console.log(`user ${user_id} joined channel ${channelId}`)
console.log(`socket ${socket.id} disconnected for user ${user_id}`)
```

→ Nên thay bằng structured logger (pino/winston).

#### m2. Không có correlation ID

Mỗi event không có ID riêng → debug khó khi có chain event.

#### m3. `databaseServices.prisma` gọi trực tiếp trong socket handler

Vi phạm separation of concerns — nên có service layer.

---

## 8. Kịch bản thực tế gây lỗi

### 8.1. Kịch bản 1: Channel lớn với traffic cao

```
- 1 channel có 5000 members
- 10 user gửi 5 message/phút = 50 msg/phút
- Mỗi message → 1 findUnique channel + 1 findMany member (5000 rows) + 4999 emit
- 50 msg × 5000 rows = 250,000 rows scan mỗi phút
- → DB CPU 100%, p99 latency > 2s
```

### 8.2. Kịch bản 2: Deploy/restart

```
- Restart server (deploy hoặc crash recovery)
- Tất cả user disconnect đồng thời
- 10,000 user reconnect cùng lúc
- Mỗi reconnect: JWT verify + 2 DB query (workspace + read state) + join rooms
- → Connection storm, DB overwhelmed
```

### 8.3. Kịch bản 3: Scale ngang không có adapter

```
- 2 Node instance chạy sau load balancer
- User A connect vào instance 1, User B connect vào instance 2
- User A gửi message → io.to("user:B") → chỉ tìm thấy socket ở instance 1
- → User B KHÔNG nhận được message
- → "Mất message" bug cực kỳ khó debug
```

### 8.4. Kịch bản 4: Network partition giữa Node và DB

```
- DB chậm (5s response time)
- Mỗi send_message phải đợi 4 query × 5s = 20s
- Trong 20s, user gửi tiếp → request queue đầy
- → Node event loop blocked, tất cả socket cũng bị stuck
```

### 8.5. Kịch bản 5: Spam attack

```
- Attacker connect 1000 socket giả (qua proxy)
- Mỗi socket gửi send_message 100 lần/giây
- → 100,000 INSERT/giây → DB down
- → Service down cho tất cả user thật
```

---

## 9. Tóm tắt vấn đề

### 9.1. Ma trận ưu tiên

| Vấn đề | Mức độ | Effort sửa | Giải pháp |
|---------|--------|------------|-----------|
| **N+1 unread query** | 🔴 Critical | Trung bình | Cache channel members (Redis) |
| **Scale ngang** | 🔴 Critical | Thấp | Socket.IO Redis adapter |
| **Mất state khi restart** | 🔴 Critical | Thấp | Redis presence |
| **Emit tuần tự** | 🟡 Medium | Thấp | Promise.all + batch |
| **Read state storm** | 🟡 Medium | Trung bình | BullMQ batch |
| **Backpressure** | 🟡 Medium | Trung bình | Ack timeout + disconnect |
| **Rate limit** | 🟡 Medium | Thấp | Middleware check |
| **Replay khi reconnect** | 🟢 Minor | Cao | Server-side queue |
| **JWT verify mỗi packet** | 🟢 Minor | Thấp | Verify 1 lần/session |

### 9.2. Đánh giá hiện tại

**Hệ thống hiện tại hoạt động tốt khi:**
- ✅ Single instance
- ✅ < 1,000 concurrent users
- ✅ < 10,000 messages/giờ
- ✅ Channel size < 100 members

**Hệ thống sẽ gặp vấn đề khi:**
- ❌ Cần scale ngang (multi-instance)
- ❌ > 5,000 concurrent users
- ❌ Channel có > 500 members
- ❌ Cần đảm bảo delivery 99.99%

### 9.3. So sánh nhanh

| Tiêu chí | Hiện tại | Cần đạt được |
|----------|----------|--------------|
| Max concurrent | ~1-2K | 50K+ |
| Scale ngang | ❌ | ✅ |
| Restart safety | ❌ | ✅ |
| DB query / message | 4 | < 1 (cache) |
| Unread emit latency | 200-500ms | < 50ms |
| Backpressure | ❌ | ✅ |
| Replay on reconnect | ❌ | ✅ |

---

## Liên kết

- **Giải pháp chi tiết:** [`Document/redis-realtime-optimization.md`](./redis-realtime-optimization.md)
- **Room policy:** [`Document/socket-room-policy.md`](./socket-room-policy.md)
- **Kiến trúc socket:** [`Document/Kien_truc_Socket_Discord_Clone.md`](./Kien_truc_Socket_Discord_Clone.md)

---

> **Tác giả:** Backend team
> **Reviewer:** TBD
> **Status:** Draft v1 — chờ feedback
