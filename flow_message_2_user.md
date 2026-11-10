# Flow gửi tin nhắn & cơ chế Unread

## 1. Trạng thái

Hệ thống unread có 2 trạng thái cho mỗi user trong mỗi channel:

| Trạng thái | Ý nghĩa | Lưu ở đâu |
|---|---|---|
| `lastReadMessageId` | Tin cuối cùng user đã đọc | DB — nguồn chân lý |
| `unread count` | Số tin chưa đọc | Redis — cache, đọc nhanh |

## 2. Vai trò

- **Server** — quản lý trạng thái đọc
- **Client** — chỉ báo tín hiệu *"tôi đang đọc"*
  - Server không biết user đang nhìn màn hình nào, đang mở channel nào, có mở app hay không

## 3. Các sự kiện

### Client → Server (2)

| Sự kiện | Ý nghĩa |
|---|---|
| `send_message` | "Tôi gửi tin" |
| `mark_read` | "Tôi đã đọc tới tin này" |

### Server → Client (3)

| Sự kiện | Ý nghĩa | Client xử lý |
|---|---|---|
| `receive_message` | Có tin mới trong channel | Hiện tin + bắn `mark_read` nếu đang mở channel |
| `channel_read` | Mốc đọc đã cập nhật | Tắt badge, cập nhật mốc đọc |
| `channel_unread` | Bạn có tin chưa đọc | Hiện badge (trừ khi đang mở đúng channel) |

## 4. Người gửi A — server tự xử lý

```
Client A ──send_message──▶ Server
                            ├─ tăng unread cho tất cả thành viên, TRỪ A
                            ├─ lastReadMessageId(A) = id tin vừa gửi
                            ├─ unread(A) = 0
                            └─ emit channel_read ──▶ user room của A
                                                  (các tab/máy khác của A đồng bộ badge)
```

**Lý do server tự quyết:** *"gửi tin"* chắc chắn đồng nghĩa *"đang đọc channel này"*.

## 5. Người nhận B — đang mở channel

```
Client B ◀──receive_message── Server
          ──mark_read──────▶ Server
                            ├─ chốt lastReadMessageId(B)
                            ├─ tính lại count
                            └─ nếu count = 0 ──emit channel_read──▶ user room của B
                                                                  (mọi tab/máy cùng tắt badge)
```

**Lý do client phải bắn `mark_read`:** chỉ client biết B có thực sự đang nhìn channel không.

**Lưu ý:** chỉ khi `count = 0` server mới bắn `channel_read` → nếu B đọc tới tin cũ hơn (còn tin gửi sau) thì các tab khác **không** được đồng bộ mốc đọc.

## 6. Người nhận B — không mở channel

```
Client B: không có listener receive_message → không bắn mark_read
    ↓
unread count của B cứ tăng dần trong Redis
    ↓
Worker đọc count mỗi ~1s (aggregator gom event thành BullMQ job)
    ↓
count > 0 → emit channel_unread ──▶ Client B
    ↓
Client so sánh channelId với channel đang mở:
  đang mở   → bỏ qua
  không mở  → hiện badge
```

## 7. Vào / rời channel

```
join_channel / leave_channel
    ↓
Server tự chốt read state tới tin mới nhất
    ├─ set count = 0
    └─ emit channel_read ──▶ Client
```

## 8. Tổng kết

- `mark_read` (tắt badge khi đang mở channel) và `channel_unread` (bật badge khi không mở channel) là **2 nhánh loại trừ lẫn nhau**, không thay thế nhau
- Mọi trường hợp server tự suy luận được (gửi tin, join, leave) → **không cần client can thiệp**
- Client chỉ can thiệp đúng 1 chỗ: **tín hiệu "tôi đang đọc tới đâu"**

## 9. Lưu ý về thiết kế hiện tại

- `join_channel` / `leave_channel` chốt mốc đọc tới `latestMessageId` (tin mới nhất của channel), **không phải** mốc B thực sự đã đọc tới
  → Hành vi hiện tại: *"vào/ra channel = coi như đã đọc hết channel"*
  → Muốn mốc đọc bám theo scroll thực tế thì 2 chỗ này cần sửa
