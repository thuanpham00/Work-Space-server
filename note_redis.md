# Note — Redis Commands đang sử dụng trong dự án

> Cập nhật: Phase 5 (Presence với Sorted Set)
> Tổng cộng: **9 lệnh** + **1 stream**

---

## 📋 Bảng tổng hợp

| # | Lệnh | Kiểu dữ liệu | File | Mục đích |
|---|---|---|---|---|
| 1 | `GET` | String | `redis.services.ts:90` | Đọc cache `channel:${id}:workspace` |
| 2 | `SET ... EX` | String | `redis.services.ts:106` | Ghi cache kèm TTL atomic |
| 3 | `DEL` | Generic | `redis.services.ts:116, 127` | Xóa cache members/workspace |
| 4 | `SADD` | Set | `redis.services.ts:70` | Thêm nhiều userId vào set members |
| 5 | `SMEMBERS` | Set | `redis.services.ts:47` | Lấy tất cả members |
| 6 | `EXPIRE` | Generic | `redis.services.ts:71`, `presence.services.ts:18` | Set TTL cho key (sau khi SADD) |
| 7 | `ZADD` | Sorted Set | `presence.services.ts:16` | Thêm socket vào presence, score=timestamp |
| 8 | `ZREM` | Sorted Set | `presence.services.ts:29` | Xóa socket khi disconnect |
| 9 | `ZCARD` | Sorted Set | `presence.services.ts:32, 42, 70` | Đếm số socket đang active |
| 10 | `ZREMRANGEBYSCORE` | Sorted Set | `presence.services.ts:66` | Worker xóa socket idle |
| - | `SCAN` (stream) | Generic | `presence.services.ts:53` | Duyệt tất cả key `presence:user:*` |

---

## 🔤 Chi tiết theo nhóm

### 1️⃣ String (lưu 1 giá trị đơn)

| Lệnh | Cú pháp | Ví dụ |
|---|---|---|
| `GET` | `GET key` | `GET channel:10:workspace` → `"5"` |
| `SET` | `SET key value [EX seconds]` | `SET channel:10:workspace "5" EX 600` |

**Đặc điểm:**
- Lưu 1 giá trị duy nhất
- `SET ... EX` là atomic (set + expire trong 1 lệnh) — ưu tiên dùng
- `SET` riêng rồi `EXPIRE` riêng → race condition có thể xảy ra

---

### 2️⃣ Set (tập hợp không trùng)

| Lệnh | Cú pháp | Ví dụ |
|---|---|---|
| `SADD` | `SADD key member [member ...]` | `SADD channel:10:members 15 20 30` |
| `SMEMBERS` | `SMEMBERS key` | `SMEMBERS channel:10:members` → `["15", "20", "30"]` |

**Cấu trúc key hiện tại:**

```
Key:    chat:channel:10:members
Type:   Set
Members: ["15", "20", "30"]   (chuỗi, vì Redis không có number)
```

---

### 3️⃣ Sorted Set (tập hợp có thứ tự theo score)

| Lệnh | Cú pháp | Ví dụ |
|---|---|---|
| `ZADD` | `ZADD key score member` | `ZADD presence:user:15 1700000000 "socket_abc"` |
| `ZREM` | `ZREM key member` | `ZREM presence:user:15 "socket_abc"` |
| `ZCARD` | `ZCARD key` | `ZCARD presence:user:15` → `2` |
| `ZREMRANGEBYSCORE` | `ZREMRANGEBYSCORE key min max` | `ZREMRANGEBYSCORE presence:user:15 -inf 1700000000` |

**Cấu trúc key:**

```
Key:    chat:presence:user:15
Type:   Sorted Set
Members: socketId (chuỗi)
Score:   Date.now() (millisecond) — timestamp lần cuối heartbeat
```

**Cú pháp đặc biệt của ZREMRANGEBYSCORE:**
- `-inf` = âm vô cực
- `+inf` = dương vô cực
- Xóa members có score trong khoảng [min, max]

---

### 4️⃣ Key-level (áp dụng cho mọi kiểu)

| Lệnh | Cú pháp | Ví dụ |
|---|---|---|
| `DEL` | `DEL key [key ...]` | `DEL channel:10:members` |
| `EXPIRE` | `EXPIRE key seconds` | `EXPIRE presence:user:15 120` |
| `SCAN` | `SCAN cursor [MATCH pattern] [COUNT count]` | `SCAN 0 MATCH chat:presence:user:*` |

**Lưu ý về EXPIRE:**
- Reset mỗi lần gọi → không tích lũy
- Dùng `SET ... EX` tốt hơn `SET` rồi `EXPIRE` riêng

---

## 🧠 Ghi nhớ nhanh

| Nhóm | Khi nào dùng |
|---|---|
| String | Cache 1 giá trị đơn (VD: workspaceId) |
| Set | Cache danh sách không trùng (VD: members) |
| Sorted Set | Cache danh sách có thứ tự / cần score để TTL (VD: presence) |
| EXPIRE | Cleanup key sau X giây không hoạt động |
| ZREMRANGEBYSCORE | Cleanup member cũ trong sorted set |

---

## 📊 Thống kê sử dụng theo phase

| Phase | Lệnh mới thêm |
|---|---|
| Phase 1-3 (Cache) | `GET`, `SET EX`, `DEL`, `SADD`, `SMEMBERS`, `EXPIRE` |
| Phase 4 (Adapter) | (không dùng lệnh trực tiếp — qua `@socket.io/redis-adapter`) |
| Phase 5 (Presence) | `ZADD`, `ZREM`, `ZCARD`, `ZREMRANGEBYSCORE`, `SCAN` |

---

## Queue, BullMQ và Worker là gì?
Queue – Hàng đợi công việc
Là nơi lưu các công việc đang chờ xử lý. Thay vì thực hiện ngay, backend đưa một công việc vào hàng đợi để xử lý sau.
Ví dụ: cập nhật unread cho channel 10.

Redis – Nơi lưu trữ hàng đợi
Trong cấu hình này, Redis lưu thông tin về các job và trạng thái của chúng. Nhờ vậy, công việc không chỉ nằm trong biến của một tiến trình Node.js.

BullMQ – Thư viện quản lý Queue
Cung cấp API để tạo queue, thêm job, chạy worker, retry khi lỗi, giới hạn tốc độ và quản lý trạng thái job.

Worker – Bộ phận thực thi công việc
Liên tục nhận các job từ queue và chạy hàm xử lý tương ứng ở phía backend.