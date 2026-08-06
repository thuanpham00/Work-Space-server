# Socket Flow (Final)

## 1. Khi user connect

- Verify JWT.
- Join room cá nhân.
- Join tất cả workspace mà user tham gia.
- Không join channel.

```text
user:1
workspace:1
workspace:2
```

---

## 2. Khi user mở channel

- Leave channel cũ (nếu có).
- Join channel mới.
- Fetch message.
- Update `ChannelReadState`.

```text
leave channel:5
join channel:8
```

---

## 3. Khi gửi message

### Bước 1

Lưu message vào Database.

---

### Bước 2

Emit realtime cho những người đang mở channel.

```text
io.to(channel:<channelId>).emit("receive_message", message)
```

---

### Bước 3

Lấy danh sách thành viên của channel (trừ người gửi).

```text
channel_members
```

---

### Bước 4

Emit trạng thái unread cho từng user online.

```text
io.to(user:<userId>).emit("channel_unread", {
    channelId,
    workspaceId,
    latestMessageId
})
```

> Chỉ gửi thông tin unread, **không gửi nội dung message**.

---

## 4. Client xử lý

### Nếu đang ở channel

Nhận

```text
receive_message
```

→ Hiển thị message realtime.

---

### Nếu không ở channel

Nhận

```text
channel_unread
```

→ Tăng badge unread của channel.

→ Workspace tự suy ra unread từ channel.

---

## 5. User offline

Không nhận socket.

Khi login hoặc refresh:

```text
GET /channels/unread
```

Server tính unread dựa trên:

- Message mới nhất.
- `ChannelReadState`.

---

# Vai trò của từng Room

## user:<id>

Dùng cho sự kiện cá nhân.

Ví dụ:

- channel_unread
- friend_request
- call_invitation
- notification

---

## workspace:<id>

Dùng cho sự kiện chung của workspace.

Ví dụ:

- workspace_updated
- member_joined
- member_left
- channel_created
- channel_deleted
- role_changed

> Không dùng để emit unread.

---

## channel:<id>

Dùng cho realtime trong channel.

Ví dụ:

- receive_message
- typing
- reaction
- edit_message
- delete_message

---

# Flow tổng quát

```text
Connect
    │
    ├── Join user:<id>
    ├── Join workspace:<id>
    │
Open Channel
    │
    ├── Leave channel cũ
    ├── Join channel mới
    └── Update ChannelReadState
    │
Send Message
    │
    ├── Save DB
    ├── Emit receive_message -> channel:<id>
    └── Emit channel_unread -> user:<id>
    │
Offline
    │
Login lại
    │
Fetch unread API
```

# Nguyên tắc

- `channel:*` → Realtime message.
- `user:*` → Notification cá nhân.
- `workspace:*` → Sự kiện của workspace.
- `ChannelReadState` là **nguồn sự thật (Source of Truth)** cho trạng thái unread.