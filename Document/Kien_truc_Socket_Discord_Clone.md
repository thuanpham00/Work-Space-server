# Kiến trúc Socket cho ứng dụng Chat kiểu Discord

## Mục tiêu

- Một user có thể tham gia nhiều Workspace.
- Mỗi Workspace có nhiều Channel.
- Mỗi Channel là một phòng chat độc lập.
- Realtime, dễ mở rộng và tiết kiệm tài nguyên.

---

# Kiến trúc Room

```
Socket Server
│
├── user:15
├── workspace:1
├── workspace:2
├── channel:10 (chỉ khi đang mở)
└── call:10 (khi gọi)
```

## 1. user:<userId>

Luôn join ngay sau khi kết nối.

Dùng cho:

- Notification
- Mention
- Friend online
- Incoming call
- Badge unread

```ts
socket.join(`user:${userId}`)
```

---

## 2. workspace:<workspaceId>

Sau khi xác thực, query tất cả workspace user tham gia và join.

```ts
socket.join(`workspace:${workspaceId}`)
```

Dùng cho:

- Tạo channel
- Đổi tên workspace
- Thêm/Xóa member
- Đổi role

---

## 3. channel:<channelId>

Chỉ join khi user mở channel.

```ts
socket.emit("join_channel", channelId)
```

Server:

```ts
socket.join(`channel:${channelId}`)
```

Khi đổi channel:

```ts
socket.leave(`channel:${oldChannel}`)
socket.join(`channel:${newChannel}`)
```

---

# Luồng Connection

```text
Connection
    │
Verify Token
    │
Query WorkspaceMember
    │
    ├── join user:<userId>
    │
    └── join workspace:1
        join workspace:2
        join workspace:3

(chưa join channel nào)
```

---

# Luồng gửi tin nhắn

```text
User A

send_message
      │
      ▼
Socket Server
      │
Save DB
      │
Query ChannelMember
      │
 ┌────┴──────────────┐
 │                   │
 ▼                   ▼
emit channel:id   emit user:id
```

## Emit tới channel

```ts
io.to(`channel:${channelId}`)
  .emit("receive_message", message)
```

Chỉ những người đang mở channel mới nhận realtime.

---

## Emit tới user

```ts
io.to(`user:${userId}`)
  .emit("notification", data)
```

Dùng để:

- Badge
- Notification
- Mention
- Unread
- Push

---

# Ví dụ

User A tham gia:

```
Workspace Dev
    ├── general
    ├── backend
    └── frontend

Workspace Company
    ├── task
    └── report
```

Sau khi login:

```
join user:A

join workspace:Dev

join workspace:Company
```

Không join channel.

Khi mở:

```
#backend
```

thì

```
join channel:backend
```

Đổi sang

```
#frontend
```

thì

```
leave channel:backend

join channel:frontend
```

---

# Tin nhắn mới

B gửi tin trong `#general`.

A đang xem `#frontend`.

Server:

```
Save DB

↓

emit channel:general

↓

emit user:A
emit user:B
emit user:C
```

A không nhận `receive_message` vì không ở room `channel:general`.

Nhưng A vẫn nhận notification để cập nhật:

- Badge channel
- Badge workspace
- Âm báo
- Popup

---

# Read State (Seen)

Không lưu:

```
message.isSeen
```

Thay vào đó lưu:

```
ChannelReadState

userId
channelId
lastReadMessageId
lastReadAt
```

Muốn biết unread:

```
message.id > lastReadMessageId
```

Chỉ cần 1 record cho mỗi User + Channel.

---

# Workspace Unread

Không cần bảng WorkspaceSeen.

Chỉ cần kiểm tra:

```
Workspace

├── general (2 unread)
├── backend (0)
└── frontend (5)
```

=> Workspace có unread.

---

# Phân tầng Room

```
Socket Server
│
├── user:*
│     Notification
│     Badge
│     Mention
│     Call
│
├── workspace:*
│     Create Channel
│     Rename
│     Member Update
│
└── channel:*
      Message
      Typing
      Reaction
      Edit
      Delete
```

---

# Kiến trúc khuyến nghị

```
Connection
    │
    ▼
join user
    │
    ▼
join tất cả workspace
    │
    ▼
User mở channel
    │
    ▼
join channel
    │
    ▼
send message
    │
    ▼
Save DB
    │
    ├── emit channel (chat realtime)
    │
    └── emit user (notification, unread)
```

## Kết luận

- `user:*` → mọi sự kiện cá nhân.
- `workspace:*` → mọi sự kiện cấp workspace.
- `channel:*` → mọi sự kiện chat realtime.
- Chỉ join channel đang mở để tiết kiệm tài nguyên.
- Notification luôn gửi qua `user:*`.
- Unread được tính từ `lastReadMessageId`, không lưu `isSeen` cho từng message.
