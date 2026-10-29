# Note — Redis Commands đang sử dụng trong dự án

> Cập nhật: Phase 7 (List — Aggregator buffer)
> Tổng cộng: **14 lệnh** + **1 stream**

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
| 11  | `LPUSH`            | List         | `queues/unread.aggregator.ts`                     | Đẩy event vào buffer (O(1), đầu list)     |
| 12  | `LRANGE`           | List         | `queues/unread.aggregator.ts`                     | Lấy toàn bộ events trong buffer            |
| 13  | `LTRIM`            | List         | `queues/unread.aggregator.ts`                     | Giới hạn độ dài buffer (chống tràn)        |
| 14  | `LLEN`             | List         | `queues/unread.aggregator.ts`                     | Đếm số event trong buffer                  |
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

### 4️⃣ List (hàng đợi có thứ tự — FIFO)

List trong Redis = mảng các chuỗi, **có thứ tự**, cho phép thêm/xóa ở **2 đầu**.

| Lệnh      | Cú pháp                                    | Ví dụ                                                    |
| --------- | ------------------------------------------ | -------------------------------------------------------- |
| `LPUSH`   | `LPUSH key element [element ...]`          | `LPUSH chat:unread:buffer '{"messageId":1001}'`         |
| `RPUSH`   | `RPUSH key element [element ...]`          | `RPUSH chat:queue job1`                                 |
| `LPOP`    | `LPOP key`                                | `LPOP chat:unread:buffer` → `"{\"messageId\":1001}"`      |
| `RPOP`    | `RPOP key`                                | `RPOP bull:unread-batch:wait`                           |
| `LRANGE`  | `LRANGE key start stop`                   | `LRANGE chat:unread:buffer 0 -1` → toàn bộ elements    |
| `LLEN`    | `LLEN key`                                | `LLEN chat:unread:buffer` → `1000`                      |
| `LTRIM`   | `LTRIM key start stop`                    | `LTRIM chat:unread:buffer 0 9999`                       |
| `BLPOP`   | `BLPOP key [key ...] timeout`             | `BLPOP queue 5` → chặn tới khi có item                  |

**Cấu trúc key (buffer của Aggregator):**

```
Key:    chat:unread:buffer
Type:   List
Value:  [ '{"channelId":10,"messageId":1001}', '{"channelId":10,"messageId":1002}' ]
```

#### Đặc điểm & đánh đổi

| Đặc điểm | Chi tiết |
| --------- | -------- |
| **Thứ tự** | Có (FIFO) — phần tử push trước nằm trước |
| **Truy cập theo index** | **KHÔNG** — không có `list[0]`, phải `LRANGE key 0 0` (O(N)) |
| **Đẩy vào đầu/tail** | `LPUSH`/`RPUSH` đều **O(1)** |
| **Xóa đầu/tail** | `LPOP`/`RPOP` đều **O(1)** |
| **Lấy phần tử giữa** | `LRANGE` là **O(N + S)** — tốn khi list dài |
| **Trùng lặp** | Cho phép (khác Set — Set là tập hợp không trùng) |
| **Blocking** | `BLPOP`/`BRPOP` — connection bị block tới khi có item |

> ⚠️ **Đừng dùng List làm "mảng có index"** — đó là job của Sorted Set hoặc Hash. List chỉ nên dùng cho **queue / buffer / stack**, tức là thao tác ở 2 đầu.

#### Tại sao List làm buffer cho Aggregator (Phase 7)?

```
Mỗi message  → LPUSH vào List            (O(1), ~0.5ms)   ← Producer nhẹ
Mỗi 1 giây  → LRANGE 0 -1 lấy hết       (O(N))          ← Flush
              → DEL buffer
              → queue.add() gom thành 1 job
```

**Vì sao không `queue.add()` ngay mỗi message?**

```
1000 message / giây = 1000 job / giây
→ 1000 lần LPUSH + 1000 lần worker pickup
→ Worker overhead ~5ms × 1000 = 5 giây CHỈ ĐỂ PICKUP
```

**Buffer pattern** gom 1000 message → **1 job** → worker xử lý 1 lần.

#### `LPUSH` vs `RPUSH` — chọn chiều nào?

| Lệnh    | Thêm vào đâu | Khi xử lý bằng `LPOP` | FIFO? |
| ------- | ------------ | ---------------------- | ----- |
| `LPUSH` | **đầu** list | Lấy từ đầu → đúng thứ tự push | ✅ FIFO |
| `RPUSH` | **cuối** list | Lấy từ đầu → ngược thứ tự push  | ❌ LIFO |

Buffer dùng `LPUSH` + `LRANGE`/`DEL` nên không vấn đề. Còn BullMQ dùng `LPUSH` (đẩy job mới vào đầu) + `BRPOP` (lấy từ cuối) → **job cũ được xử lý trước** = FIFO thật sự.

#### `LTRIM` chống tràn

```typescript
await connection.lpush(BUFFER_KEY, JSON.stringify(event))
await connection.ltrim(BUFFER_KEY, 0, BUFFER_MAX_SIZE - 1)  // giữ 10000 phần tử đầu
```

- `LTRIM key start stop` — giữ lại các phần tử từ index `start` đến `stop`, **xoá phần còn lại**.
- `LTRIM buffer 0 9999` → giữ 10000 phần tử đầu.
- Phòng worker chết → không ai flush → buffer phình vô hạn → Redis đầy.

#### Blocking pop — vì sao quan trọng với Worker?

```redis
BRPOP bull:unread-batch:wait 5
```

- Worker **không poll liên tục** (tốn RTT vô ích).
- Connection bị **block** tới khi có job → Redis "đánh thức" worker.
- Timeout (giây) → trả `nil` nếu hết thời gian, worker ngủ tiếp.

> 📌 BullMQ dùng chính cơ chế này (`BRPOPLPUSH` để move job sang list `active`). Vì vậy **Worker cần connection riêng** — connection đang block không được dùng cho lệnh thường.

---

### 5️⃣ Key-level (áp dụng cho mọi kiểu)

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
| List             | Queue / buffer FIFO — thêm xóa ở 2 đầu (VD: unread buffer) |
| EXPIRE           | Cleanup key sau X giây không hoạt động                      |
| ZREMRANGEBYSCORE | Cleanup member cũ trong sorted set                          |
| LTRIM            | Giới hạn độ dài List buffer (chống tràn)                   |

### Chọn kiểu dữ liệu nhanh

| Cần gì?                            | Dùng       | Lệnh then chốt        |
| ---------------------------------- | ---------- | --------------------- |
| 1 giá trị đơn                      | String     | `GET` / `SET EX`      |
| Tập hợp không trùng                | Set        | `SADD` / `SMEMBERS`   |
| Cần thứ tự theo score / timestamp  | Sorted Set | `ZADD` / `ZRANGE`     |
| FIFO, thêm-xóa ở 2 đầu, buffer    | List       | `LPUSH` / `BRPOP`    |
| Lấy field cụ thể trong 1 object   | Hash       | `HSET` / `HGETALL`    |
| Broadcast 1-n, không cần lưu      | Pub/Sub    | `PUBLISH` / `SUBSCRIBE` |
| Event stream có replay             | Stream     | `XADD` / `XREAD`      |

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

### Shape của từng kiểu

```
┌─ String ─────────────────────────┐
│  chat:channel:10:workspace       │
│  Value: "5"                      │
└───────────────────────────────────┘

┌─ Set ────────────────────────────┐
│  chat:channel:10:members         │
│  Value: ["15", "20", "30"]        │
└───────────────────────────────────┘

┌─ Sorted Set ─────────────────────┐
│  chat:presence:user:15           │
│  Value: { socket_abc: 17000... } │  ← member + score
└───────────────────────────────────┘

┌─ List ───────────────────────────┐
│  chat:unread:buffer              │
│  Value: [ "{...}", "{...}" ]      │  ← có thứ tự, trùng lặp OK
└───────────────────────────────────┘
```

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
| Phase 6 (BullMQ)   | (BullMQ tự quản lý — `LPUSH`/`BRPOP`/`BRPOPLPUSH`)          |
| Phase 7 (List)     | `LPUSH`, `LRANGE`, `LTRIM`, `LLEN`                           |

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

> 📌 **BullMQ dùng List làm queue thật**: `LPUSH` job mới vào đầu list `:wait`, worker `BRPOP` lấy từ cuối → job **cũ được xử lý trước** (FIFO). Đây cũng là lý do Worker cần connection riêng: `BRPOP` **block** connection, nếu dùng chung thì các lệnh thường sẽ bị treo.

### Producer — Consumer

- **Producer:** `queue.add(name, data)` — đẩy job vào
- **Consumer (Worker):** chạy liên tục, pickup job ra xử lý

**Producer** = bên tạo & đẩy job vào queue, **không tự xử lý** (fire-and-forget), không đợi kết quả.
**Consumer** = worker chạy nền, tự lấy job ra xử lý, retry khi fail.

> ⚠️ Delivery = **at-least-once** → job có thể chạy 2 lần → consumer phải **idempotent**.

### Chi phí RTT (Round-Trip Time)

**RTT** = thời gian gói tin đi từ client → server **và quay lại**. Mỗi lệnh Redis tuần tự = **1 RTT**.

```
Client --LPUSH key v----> Server
Client <---- "OK" ------ Server     ← tổng = 1 RTT
```

**Chi phí RTT** = *số round-trip × thời gian mỗi RTT*. Đây là độ trễ do **mạng**, tách biệt với độ trễ do **xử lý**.

| Khoảng cách | RTT điển hình |
| ------------ | ------------- |
| Cùng máy / LAN | ~0.1 – 1 ms |
| Cloud + client cùng khu vực | ~10 – 30 ms |
| Cloud + client xa (EU/US) | ~150 – 250 ms |

**Giảm chi phí RTT:**

1. **Pipeline / `MGET`** — gộp N lệnh thành 1 RTT.
2. **Lua script** — gộp logic vào 1 round-trip, atomic trên server.
3. **Cache Redis** — né round-trip tới Postgres (giống `redis.services.ts` TTL 300s/600s).
4. **Batch/Aggregator** — 1000 `LPUSH` (1000 RTT) → gom thành **1 job** (~1 RTT + 1 RTT `queue.add`).

```typescript
// 2 lệnh tuần tự = 2 RTT
const ws = await redis.get(`channel:${id}:workspace`)
const members = await redis.smembers(`channel:${id}:members`)

// Pipeline = 1 RTT
const pipeline = redis.pipeline()
pipeline.get(`channel:${id}:workspace`)
pipeline.smembers(`channel:${id}:members`)
const [[, ws], [, members]] = await pipeline.exec()
```

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

---

## 📦 Phase 7 — List làm buffer (Aggregator)

### Vấn đề: 1 message → 1 job là quá nhiều

```
1000 message / giây = 1000 job / giây
→ 1000 lần LPUSH (Producer)
→ 1000 lần worker pickup
→ Worker overhead ~5ms × 1000 = 5 giây CHỈ ĐỂ PICKUP
```

### Giải pháp: Buffer pattern (gom trước, xử lý sau)

```
Mỗi message  → LPUSH vào List Redis           (O(1), ~0.5ms)   ← Producer nhẹ
Mỗi 1 giây  → LRANGE 0 -1 lấy hết             (O(N))          ← Flush
              → DEL buffer
              → unreadQueue.add() gom thành 1 job
              → Worker xử lý 1 job chứa N events              ← Consumer
```

**1000 msg/s → 1 job/s (chứa ~1000 events)**

### Code mẫu

```typescript
const BUFFER_KEY = 'unread:buffer'
const BUFFER_MAX_SIZE = 10000
const FLUSH_INTERVAL = 1000

// ============ PRODUCER ============
export const enqueueUnread = async (event: UnreadEvent): Promise<void> => {
  await connection.lpush(BUFFER_KEY, JSON.stringify(event))
  await connection.ltrim(BUFFER_KEY, 0, BUFFER_MAX_SIZE - 1)
}

// ============ CONSUMER (FLUSH SCHEDULER) ============
export const startUnreadAggregator = () => {
  setInterval(async () => {
    // 1. Lấy toàn bộ events
    const events = await connection.lrange(BUFFER_KEY, 0, -1)
    if (events.length === 0) return

    // 2. Xoá buffer TRƯỚC khi xử lý
    await connection.del(BUFFER_KEY)

    // 3. Parse + lọc lỗi
    const parsed = events
      .map((e) => {
        try {
          return JSON.parse(e) as UnreadEvent
        } catch {
          return null
        }
      })
      .filter((e): e is UnreadEvent => e !== null)
    if (parsed.length === 0) return

    // 4. Gom thành 1 job
    await unreadQueue.add('batch', { events: parsed })
  }, FLUSH_INTERVAL)
}
```

### ⚠️ Thứ tự bắt buộc: `LRANGE` → `DEL` → `queue.add`

| Sai | Hậu quả |
| --- | ------- |
| `DEL` trước `LRANGE` | **Mất data** — xoá trước khi lấy |
| `queue.add` trước `DEL` | Event mới push vào bị `DEL` xoá mất |

Vì `DEL` chạy trước khi xử lý → event mới push sau đó rơi vào buffer rỗng → interval kế tiếp lấy được. Nhưng **nếu server crash giữa `LRANGE` và `queue.add`** → mất event → buffer chỉ là tạm, **không được làm source of truth**.

### Vì sao chọn List mà không chọn Set / Sorted Set?

| Kiểu    | Có thứ tự? | Trùng lặp? | Đánh giá                                    |
| ------- | ----------- | ---------- | ------------------------------------------- |
| **List** | ✅ FIFO      | ✅ OK       | **Đúng** — buffer là hàng đợi, cần thứ tự  |
| Set     | ❌           | ❌          | Mất thứ tự, mất event trùng                  |
| Sorted Set | ✅ (score)  | ❌          | Overkill — cần score, không cần query range |

### Lệnh List thường dùng trong dự án

| Lệnh      | Dùng ở đâu                        | Ghi chú |
| --------- | --------------------------------- | ------- |
| `LPUSH`   | `enqueueUnread()` — đẩy event     | O(1), thêm vào đầu |
| `LRANGE`  | Aggregator — lấy toàn bộ          | `0 -1` = tất cả, O(N) |
| `LTRIM`   | `enqueueUnread()` — giới hạn size | Chống buffer phình vô hạn |
| `LLEN`    | Kiểm tra số event trước flush     | Tránh tạo job rỗng |
| `DEL`     | Xoá buffer sau khi lấy            | Xoá key cả list |
| `BRPOP`   | BullMQ Worker — lấy job (internal) | Block, không poll |

### So sánh List vs BullMQ (khi nào dùng gì)

| Tiêu chí            | List buffer (Aggregator) | BullMQ queue trực tiếp |
| ------------------- | ------------------------ | ---------------------- |
| Ghi vào             | `LPUSH` — 1 RTT, rất rẻ | `queue.add()` — nặng hơn (Lua script, nhiều key) |
| Số job/giây         | 1 job / giây             | 1 job / message (1000/s) |
| Retry khi fail      | ❌ không có               | ✅ exponential backoff   |
| Stalled detection   | ❌                        | ✅ heartbeat 30s        |
| Độ trễ              | +1 giây (chờ flush)      | ~5–50ms                |
| Phù hợp khi         | Cần batch, không cần retry ngay | Cần retry + độ trễ thấp |
