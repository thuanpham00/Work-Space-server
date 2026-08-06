# Socket Room Policy

## 1. Nguyên tắc gốc

- `user:<userId>`: chỉ dùng cho notification cá nhân, unread, call, friend request.
- `workspace:<workspaceId>`: chỉ dùng cho sự kiện cấp workspace.
- `channel:<channelId>`: chỉ dùng cho realtime của channel đang mở.
- `ChannelReadState` trong DB là nguồn sự thật cho unread, socket chỉ là tín hiệu cập nhật UI.

---

## 2. Phân loại event

| Event | Room đích | Có nên emit realtime không | Ghi chú |
|---|---|---:|---|
| `receive_message` | `channel:<channelId>` | Có | Chỉ người đang mở channel nhận ngay |
| `channel_unread` | `user:<userId>` | Có | Chỉ gửi tín hiệu nhẹ, không gửi full message |
| `typing` | `channel:<channelId>` | Có | Chỉ nên sống ngắn, có debounce/throttle |
| `reaction_add` / `reaction_remove` | `channel:<channelId>` | Có | Nếu channel đông thì cân nhắc batch |
| `edit_message` | `channel:<channelId>` | Có | Chỉ broadcast diff hoặc message cập nhật |
| `delete_message` | `channel:<channelId>` | Có | Emit một event nhẹ, không đẩy payload lớn |
| `channel_created` / `channel_deleted` / `channel_renamed` | `workspace:<workspaceId>` | Có | Sự kiện cấu trúc workspace |
| `member_joined` / `member_left` / `role_changed` | `workspace:<workspaceId>` | Có | Sự kiện cấp workspace |
| `friend_request` / `call_invitation` | `user:<userId>` | Có | Notification cá nhân |
| Unread sync khi login lại | API + DB | Không phụ thuộc socket | Socket chỉ hỗ trợ online sync |

---

## 3. Luồng nên giữ

### User connect

- Join `user:<userId>`.
- Join tất cả `workspace:<workspaceId>`.
- Chưa join channel nào.

### User mở channel

- Leave channel cũ nếu có.
- Join channel mới.
- Fetch message gần nhất.
- Update `ChannelReadState`.

### Có message mới

- Lưu DB.
- Emit `receive_message` vào `channel:<channelId>`.
- Emit `channel_unread` vào `user:<userId>` cho các user online liên quan nhưng không ở channel đó.

---

## 4. Cái gì dễ phình nhất

- `typing` nếu bắn liên tục không debounce.
- `reaction` nếu nhiều người spam.
- `unread` nếu emit theo từng message cho quá nhiều user.
- `workspace` room nếu nhét quá nhiều event chi tiết vào đó.

---

## 5. Quy tắc chống phình

- `typing` phải debounce 1 đến 2 giây.
- `unread` chỉ emit signal nhẹ, không emit full message.
- Channel đông thì ưu tiên batch reaction / edit nếu có thể.
- Mọi unread cuối cùng vẫn phải tính lại từ DB khi user mở app hoặc refresh.
- Không dùng `workspace` room để đẩy message content.

---

## 6. Kết luận

Thiết kế ổn nếu giữ đúng vai trò của từng room.
Nó sẽ chỉ bắt đầu nặng khi mỗi message kéo theo quá nhiều event phụ cho nhiều nhóm người.
Muốn bền lâu, hãy để `channel` chỉ lo nội dung đang xem, `user` lo notification cá nhân, `workspace` lo state cấp cao.
