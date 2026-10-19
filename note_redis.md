# Note — Redis Commands đang sử dụng trong dự án

> Cập nhật: Phase 5 (Presence với Sorted Set)
> Tổng cộng: **9 lệnh** + **1 stream**

---

## 📋 Bảng tổng hợp

| #   | Lệnh               | Kiểu dữ liệu | File                                              | Mục đích                                  |
| --- | ------------------ | ------------ | ------------------------------------------------- | ----------------------------------------- |
| 1   | `GET`              | String       | `redis.services.ts:90`                            | Đọc cache `channel:${id}:workspace`       |
| 2   | `SET ... EX`       | String       | `redis.services.ts:106`                           | Ghi cache kèm TTL atomic                  |
| 3   | `DEL`              | Generic      | `redis.services.ts:116, 127`                      | Xóa cache members/workspace               |
| 4   | `SADD`             | Set          | `redis.services.ts:70`                            | Thêm nhiều userId vào set members         |
| 5   | `SMEMBERS`         | Set          | `redis.services.ts:47`                            | Lấy tất cả members                        |
| 6   | `EXPIRE`           | Generic      | `redis.services.ts:71`, `presence.services.ts:18` | Set TTL cho key (sau khi SADD)            |
| 7   | `ZADD`             | Sorted Set   | `presence.services.ts:16`                         | Thêm socket vào presence, score=timestamp |
| 8   | `ZREM`             | Sorted Set   | `presence.services.ts:29`                         | Xóa socket khi disconnect                 |
| 9   | `ZCARD`            | Sorted Set   | `presence.services.ts:32, 42, 70`                 | Đếm số socket đang active                 |
| 10  | `ZREMRANGEBYSCORE` | Sorted Set   | `presence.services.ts:66`                         | Worker xóa socket idle                    |
| -   | `SCAN` (stream)    | Generic      | `presence.services.ts:53`                         | Duyệt tất cả key `presence:user:*`        |

---

## 🔤 Chi tiết theo nhóm

### 1️⃣ String (lưu 1 giá trị đơn)

| Lệnh  | Cú pháp                      | Ví dụ                                 |
| ----- | ---------------------------- | ------------------------------------- |
| `GET` | `GET key`                    | `GET channel:10:workspace` → `"5"`    |
| `SET` | `SET key value [EX seconds]` | `SET channel:10:workspace "5" EX 600` |

**Đặc điểm:**

- Lưu 1 giá trị duy nhất
- `SET ... EX` là atomic (set + expire trong 1 lệnh) — ưu tiên dùng
- `SET` riêng rồi `EXPIRE` riêng → race condition có thể xảy ra

---

### 2️⃣ Set (tập hợp không trùng)

| Lệnh       | Cú pháp                        | Ví dụ                                                |
| ---------- | ------------------------------ | ---------------------------------------------------- |
| `SADD`     | `SADD key member [member ...]` | `SADD channel:10:members 15 20 30`                   |
| `SMEMBERS` | `SMEMBERS key`                 | `SMEMBERS channel:10:members` → `["15", "20", "30"]` |

**Cấu trúc key hiện tại:**

```
Key:    chat:channel:10:members
Type:   Set
Members: ["15", "20", "30"]   (chuỗi, vì Redis không có number)
```

---

### 3️⃣ Sorted Set (tập hợp có thứ tự theo score)

| Lệnh               | Cú pháp                        | Ví dụ                                               |
| ------------------ | ------------------------------ | --------------------------------------------------- |
| `ZADD`             | `ZADD key score member`        | `ZADD presence:user:15 1700000000 "socket_abc"`     |
| `ZREM`             | `ZREM key member`              | `ZREM presence:user:15 "socket_abc"`                |
| `ZCARD`            | `ZCARD key`                    | `ZCARD presence:user:15` → `2`                      |
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

| Lệnh     | Cú pháp                                     | Ví dụ                               |
| -------- | ------------------------------------------- | ----------------------------------- |
| `DEL`    | `DEL key [key ...]`                         | `DEL channel:10:members`            |
| `EXPIRE` | `EXPIRE key seconds`                        | `EXPIRE presence:user:15 120`       |
| `SCAN`   | `SCAN cursor [MATCH pattern] [COUNT count]` | `SCAN 0 MATCH chat:presence:user:*` |

**Lưu ý về EXPIRE:**

- Reset mỗi lần gọi → không tích lũy
- Dùng `SET ... EX` tốt hơn `SET` rồi `EXPIRE` riêng

---

## 🧠 Ghi nhớ nhanh

| Nhóm             | Khi nào dùng                                                |
| ---------------- | ----------------------------------------------------------- |
| String           | Cache 1 giá trị đơn (VD: workspaceId)                       |
| Set              | Cache danh sách không trùng (VD: members)                   |
| Sorted Set       | Cache danh sách có thứ tự / cần score để TTL (VD: presence) |
| EXPIRE           | Cleanup key sau X giây không hoạt động                      |
| ZREMRANGEBYSCORE | Cleanup member cũ trong sorted set                          |

---

## 🏗️ Cấu trúc 1 entry trong Redis

Mỗi key trong Redis có **3 thuộc tính**:

```
┌──────────────────────────────────────────────────┐
│  Key   :  chat:presence:user:15                  │  ← định danh (duy nhất)
│  Type  :  zset (Sorted Set)                      │  ← kiểu dữ liệu (cố định)
│  Value :  {                                      │
│             "socket_abc": 1700000000,            │  ← member + score
│             "socket_def": 1700000030             │
│           }                                      │
│  TTL   :  120 giây                               │  ← optional (nếu có EXPIRE)
└──────────────────────────────────────────────────┘
```

**Lưu ý:**

- `Key` bắt buộc — dùng để truy cập
- `Type` tự set khi ghi lần đầu — quyết định lệnh dùng được
- `Value` tùy theo type (String / Set / ZSet / Hash / List)
- `TTL` optional — tự xóa sau X giây nếu không refresh

**Redis = map\<Key, {Type, Value, TTL?}\>**

---

## 🔄 2 kiểu comment thường gặp trong code Redis

| Loại | Vai trò | Ví dụ |
|---|---|---|
| **Mô tả cấu trúc (Shape)** | Cho biết data trông như nào | `Type: Set / Members: ["15", "20"]` |
| **Giải thích logic (Reasoning)** | Cho biết tại sao code viết vậy | `EXPIRE = 2x PRESENCE_TTL (cleanup nếu offline hoàn toàn)` |

Hai kiểu này **khác nhau**, không thay thế nhau.

---

## 📊 Thống kê sử dụng theo phase

| Phase              | Lệnh mới thêm                                                |
| ------------------ | ------------------------------------------------------------ |
| Phase 1-3 (Cache)  | `GET`, `SET EX`, `DEL`, `SADD`, `SMEMBERS`, `EXPIRE`         |
| Phase 4 (Adapter)  | (không dùng lệnh trực tiếp — qua `@socket.io/redis-adapter`) |
| Phase 5 (Presence) | `ZADD`, `ZREM`, `ZCARD`, `ZREMRANGEBYSCORE`, `SCAN`          |

---

## 🎯 Presence — Cơ chế 2 lớp cleanup

Presence dùng **2 cơ chế chạy song song** để đảm bảo Redis không có "zombie socket":

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   CLIENT                              SERVER                 │
│                                                              │
│   emit('heartbeat') ──────►  setUserOnline()                 │
│         │                       ZADD score mới               │
│      30s/lần                    EXPIRE reset TTL             │
│                                                              │
│                                cleanupIdlePresence()         │
│                                ↑ 60s/lần                     │
│                                │ Cron job tự chạy            │
│                                │                             │
│                                └──► ZREMRANGEBYSCORE         │
│                                     xóa score cũ             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Lớp 1: Client heartbeat (chủ động)

```typescript
export const setUserOnline = async (userId, socketId) => {
  await redis.zadd(key, Date.now(), socketId)    // refresh score
  await redis.expire(key, PRESENCE_TTL * 2)      // reset TTL = 120s
}
```

- Client emit `heartbeat` mỗi **30s**
- Server nhận → `ZADD` score mới + `EXPIRE` reset TTL

### Lớp 2: Server cron (bị động)

```typescript
export const cleanupIdlePresence = async () => {
  const cutoff = Date.now() - PRESENCE_TTL * 1000  // = now - 60s
  // ZREMRANGEBYSCORE xóa mọi member có score ≤ cutoff
}
```

- Cron chạy mỗi **60s**
- Tự quét tất cả key `presence:user:*` qua `SCAN`
- Xóa member có score cũ hơn 60s — **không cần client**

### Tại sao cần cả 2?

| Tình huống | Chỉ heartbeat | Chỉ cron | Cả hai |
|---|---|---|---|
| Client đóng tab sạch sẽ | ✅ | ❌ | ✅ |
| Client mất mạng (không có disconnect) | ✅ (timeout ngắn) | ✅ (timeout 60s) | ✅ |
| Server crash + restart | ✅ (cron tiếp tục) | ❌ | ✅ |

### Timeline ví dụ (PRESENCE_TTL = 60s)

```
T=0s:   User mở 2 tab → ZADD 2 socket, EXPIRE 120s
T=30s:  Heartbeat cả 2 tab → score refresh, EXPIRE reset
T=45s:  Tab 1 mất mạng, không có disconnect event
T=90s:  Cron T=90 → cutoff = 30 → xóa socket_1 (score 30 ≤ 30) ✅
T=210s: Nếu cả 2 tab đều chết → EXPIRE hết → key tự xóa
```

### `ZREM` vs `ZREMRANGEBYSCORE`

| Hàm | Xóa theo | Dùng ở đâu |
|---|---|---|
| `ZREM` | Member name cụ thể | `setUserOffline` — biết socketId disconnect |
| `ZREMRANGEBYSCORE` | **Khoảng score** | `cleanupIdlePresence` — xóa theo cutoff |

`ZREMRANGEBYSCORE key -inf cutoff` = xóa mọi member có score ≤ cutoff.

`-inf` = âm vô cùng (không giới hạn dưới). `+inf` = dương vô cùng.

### `ZCARD` sau khi xóa

```typescript
const removed = await redis.zremrangebyscore(key, '-inf', cutoff)
const count = await redis.zcard(key)
if (count === 0) await redis.del(key)   // rỗng → xóa key
```

**Tại sao xóa key rỗng?** Tiết kiệm memory, tránh key "ma" tồn tại mãi.

---

## 📡 Broadcast — Phase nào làm gì?

| Phase | Tên | Vai trò | Có broadcast? |
|---|---|---|---|
| 1-3 | Cache | Giảm query DB | ❌ |
| **4** | **Redis Adapter** | **Multi-instance Socket.IO** | **✅ (cơ sở)** |
| 5 | Presence | User online | ❌ |
| 6 | BullMQ Worker | Tách job nặng | ❌ |
| 7 | Aggregator | Gom job trước khi push | ❌ |
| **8** | **Pub/Sub Notify** | **Cross-instance emit từ Worker** | **✅ (hoàn thiện)** |

**Hai phase broadcast:**

- **Phase 4** — Socket.IO adapter: socket handler → fan-out tới tất cả instance (bị giấu, code không thay đổi)
- **Phase 8** — Pub/Sub: Worker xử lý job xong → publish → các instance subscribe → fan-out

**Phase 4 không đủ vì:** chỉ giải quyết emit từ socket handler. Khi Phase 6 thêm Worker (không phải socket handler), Worker cần Phase 8 để broadcast.

---

## 🐂 Phase 6 — BullMQ (lý thuyết tối thiểu)

### Queue là gì?

```
Main flow:                Queue:                Worker (chạy nền):
- Lưu message             [job1] ←───┐         - Pickup job
- Emit real-time          [job2]      │         - Xử lý
- Đẩy "unread" job       [job3]      │         - Retry nếu fail
  (1ms)                   ...        │
                                      └──── Push job
```

**Main flow không cần đợi worker. Trả response ngay cho user.**

### BullMQ là gì?

Thư viện queue dùng Redis làm storage. Job lưu trong Redis, worker đọc và xử lý.

**Cấu trúc key Redis BullMQ tự quản lý:**

```
bull:unread-batch:wait      ← List các job chờ
bull:unread-batch:active    ← Set job đang chạy
bull:unread-batch:completed ← Sorted Set job xong
bull:unread-batch:failed    ← Sorted Set job fail
```

### Producer — Consumer

- **Producer:** `queue.add(name, data)` — đẩy job vào
- **Consumer (Worker):** chạy liên tục, pickup job ra xử lý

### Competing consumers (scale)

Nhiều worker cùng consume 1 queue → Redis đảm bảo mỗi job chỉ đi đến 1 worker (atomic). → **Horizontal scaling cho worker.**

### Exponential backoff

```
Failure 1 → wait 1s → retry
Failure 2 → wait 2s → retry
Failure 3 → wait 4s → retry
Failure 4 → DLQ (dead letter queue, manual)
```

**Tại sao cần?** Nếu DB tạm quá tải, retry ngay chỉ làm tệ hơn. Đợi vài giây → DB recover.

### Tại sao BullMQ yêu cầu `maxRetriesPerRequest: null`?

```typescript
const connection = new IORedis(url, { maxRetriesPerRequest: null })
```

- `ioredis` mặc định retry 3 lần rồi throw
- BullMQ tự quản lý retry ở tầng job (exponential backoff)
- Nếu ioredis tự retry → BullMQ không biết job fail → mất kiểm soát

### Vì sao Redis phù hợp làm storage cho Queue?

| Tính chất Redis | Lợi ích cho Queue |
|---|---|
| **Atomic** | Mỗi job chỉ đến 1 worker |
| **Persistent** (AOF/RDB) | Server crash không mất job |
| **Pub/Sub** | Worker listen event real-time |
| **Sorted Set** | Score = timestamp, query theo thời gian |
| **Nhanh** | Push/pop ~1ms |

---

## 🚦 Flow đầy đủ Phase 4 + 8 (cross-instance notify)

```
User A (Tab)                    User B (Tab)
     │                              │
     │  :3000                       │  :3001
     ▼                              ▼
┌─────────┐                    ┌─────────┐
│Instance A│                    │Instance B│
│  send ──┼──► DB save         │         │
│  Queue job ──► BullMQ ──► Worker (Instance A)
│                              │   │
│                              │   ▼
│                              │   Publish "notify:user:B" lên Redis
│              ┌───────────────┼────────────────┐
│              ▼               ▼                ▼
│         Subscribe      Subscribe        Subscribe
│         (no user B)    (no user A)     (có user B → emit)
│              │               │                │
└──────────────┼───────────────┼────────────────┘
               │               │                ▼
               │               │           User B nhận 🎉
               ▼               ▼
          (no-op)          (no-op)
```

---

## 📌 Tổng kết

> **Phase 5 = Presence độc lập** (1 instance test pass).
> **Phase 4 = Broadcast cơ sở** (Socket.IO adapter).
> **Phase 6 = Tách job nặng** (BullMQ worker).
> **Phase 7 = Gom job** (Aggregator).
> **Phase 8 = Broadcast cho Worker** (Pub/Sub notify).

**Thứ tự khuyến nghị:** Phase 5 → 6 → test lại 5 trên multi-instance → 7 → 8.

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
