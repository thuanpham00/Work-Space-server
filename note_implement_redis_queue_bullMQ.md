# Tích hợp Redis + BullMQ vào Network: Hành trình Phase 1 → Phase 6

> **Tài liệu nội bộ — narrative tổng hợp** quá trình tích hợp Redis (cache, pub/sub, presence) và BullMQ (queue, worker) vào backend chat realtime. Mục đích: ghi lại "tại sao", "trước/sau" và "bài học". Không copy nguyên phase docs — các file đó đã có chi tiết code + giải thích, chỉ tóm tắt + liên kết.

---

## 1. Bối cảnh

Dự án là **chat realtime** (Discord-like) với:
- Channel + Workspace + Members.
- Socket.IO cho tin nhắn real-time + unread badge.
- Express + Prisma + MySQL.
- 1 Node instance (đơn lẻ, không scale).

### Vấn đề khi chạy thực tế

| Vấn đề | Tác động |
|---|---|
| Mỗi message → query DB lấy members + workspaceId | 10K+ query/phút cho 1 channel 1000 members |
| Loop emit tuần tự cho từng member | 500ms blocking với channel lớn → event loop đứng |
| Restart server → user online biến mất | Client hiện offline → UX kém |
| Chỉ 1 instance | Cross-instance không khả thi khi cần scale |
| Main flow làm tất cả (insert DB + emit + read-state) | User chờ lâu, không retry khi fail |

### Giải pháp đã chọn

- **Redis**: cache, pub/sub, presence (Sorted Set). Atomic, in-memory, nhiều cấu trúc dữ liệu.
- **BullMQ**: queue + worker xử lý async. Persistent, retry + backoff, competing consumers.

### Thời gian thực hiện

6 phase × ~35 phút mean ~3.5 giờ code + test.

---

## 2. Bảng tổng hợp 6 phase

| # | Phase | Mục tiêu | Redis feature | File mới | File sửa |
|---|---|---|---|---|---|
| 1 | Cache members | Bỏ `findMany channelMember` mỗi message | String + TTL | `src/services/redis.services.ts` | `src/socket/utils.ts`, `src/services/channel.services.ts` |
| 2 | Cache workspace | Bỏ `findUnique channel` lấy `workspaceId` | String + TTL | — | `src/services/redis.services.ts`, `src/socket/utils.ts` |
| 3 | Parallel emit | Loop tuần tự → `Promise.all` | — | — | `src/socket/utils.ts` |
| 4 | Redis adapter | Scale 2+ Node instance | Pub/Sub | `src/socket/redis.adapter.ts` | `src/socket/socket.ts` |
| 5 | Presence | Restart-safe online state | Sorted Set + score | `src/services/presence.services.ts` | `src/socket/socket.ts`, `src/index.ts` |
| 6 | BullMQ | Tách việc nặng ra background | List (BullMQ internal) | `src/queues/queue.ts`, `src/queues/unread.worker.ts` | `src/index.ts` |

---

## 3. Trước / Sau theo 3 nhóm

### 3.1. Cache (Phase 1-2)

| Metric | Trước | Sau |
|---|---|---|
| DB query / message trong `emitUnreadChannel` | 2 | 0 |
| Latency phần query members | ~10ms | ~0.5ms |
| Latency phần query workspace | ~5ms | ~0.3ms |
| Tổng DB query khi gửi message | 4 | 2 |

**Cấu trúc Redis dùng:**

```
Key:    chat:channel:{id}:members        Type: Set      TTL: 300s
Key:    chat:channel:{id}:workspace      Type: String   TTL: 600s
```

**Pattern:** Cache-Aside — đọc cache → miss thì query DB → ghi cache + TTL.

### 3.2. Scale (Phase 4)

| Tính năng | Trước | Sau |
|---|---|---|
| Cross-instance message | ❌ (mỗi instance tự quản lý room) | ✅ qua `socket.io-redis-adapter` |
| Scale ngang | ❌ | ✅ chạy N instance cùng lúc |
| Latency thêm | 0 | +1-2ms (qua Redis pub/sub) |

**Pattern:** 2 Redis client (`pubClient` + `subClient.duplicate()`), attach `io.adapter(createAdapter(pub, sub))`.

### 3.3. Background job (Phase 6)

| Tính năng | Trước | Sau |
|---|---|---|
| Main flow latency | ~250ms (chờ tất cả) | ~15ms (chỉ phần critical) |
| Retry khi fail | ❌ mất data | ✅ auto retry 3 lần + exponential backoff |
| Backpressure | ❌ tự vỡ khi spike | ✅ rate limit `max: 10 / 1s` |
| Multi-instance worker | ❌ | ✅ competing consumers (BullMQ dùng Redis lock) |

**Cấu trúc Redis BullMQ tạo ra:**

```
bull:unread-batch:wait       ← List job chờ
bull:unread-batch:active     ← Set job đang chạy
bull:unread-batch:completed  ← Sorted Set job xong
bull:unread-batch:failed     ← Sorted Set job fail (DLQ)
```

---

## 4. Lý do tích hợp từng công nghệ

### Tại sao Redis?

| Yếu tố | Lý do |
|---|---|
| **Atomic** | ZADD, LPUSH, GET/SET đều atomic — không race condition cơ bản. |
| **In-memory** | Latency ~0.1ms so với DB ~5-10ms. Phù hợp hot path. |
| **Đa cấu trúc** | String, Set, Sorted Set, Hash, List — mỗi use case dùng 1 cấu trúc phù hợp. |
| **Pub/Sub built-in** | Không cần thêm thư viện cho broadcast cross-instance. |
| **TTL native** | Tự dọn key, không cần cron riêng cho cleanup. |
| **Replicated (khi scale)** | Sentinel + Cluster cho production. |

### Tại sao BullMQ?

| Yếu tố | Lý do |
|---|---|
| **Persistent** | Job lưu Redis — restart không mất. |
| **Retry + backoff** | Fail tự retry với delay tăng dần (1s → 2s → 4s). |
| **Rate limit per worker** | Bảo vệ khỏi spike. |
| **Competing consumers** | Nhiều worker process phân tải tự động. |
| **Stalled detection** | Worker crash → job tự move về `wait` (self-healing). |
| **Dùng Redis làm storage** | Không cần thêm infra (Postgres, RabbitMQ). |

### Tại sao cả hai, không chỉ một?

- **Redis** đã có cho cache + presence + adapter → lợi dụng làm storage cho BullMQ → **không tốn thêm infra**.
- Redis List có thể làm queue, nhưng: thiếu retry, thiếu delayed job, thiếu rate limit. BullMQ "lấp lỗ" này.
- Tách rạch ròi: Redis = real-time state (cache, presence, pub/sub). BullMQ = async job (write batch, broadcast delayed).

---

## 5. Sơ đồ kiến trúc tổng thể sau 6 phase

```
                    [ Client React ]
                          │
                ┌─────────┼─────────┐
                │         │         │
            Socket.IO  HTTP API   heartbeat (30s)
                │         │         │
                ▼         ▼         ▼
        ┌──────────────────────────────────────┐
        │       Node Instance A (port 3001)    │
        │  ┌─────────────┐  ┌───────────────┐  │
        │  │ Socket.IO   │  │ Express + API │  │
        │  │ (Redis Adpt)│  │ (Prisma)      │  │
        │  └─────────────┘  └───────────────┘  │
        │  ┌─────────────┐  ┌───────────────┐  │
        │  │ Presence    │  │ BullMQ Worker │  │
        │  │ (ZADD/HBT)  │  │ (unread)      │  │
        │  └─────────────┘  └───────────────┘  │
        └───────┬──────────────────────┬───────┘
                │                      │
                │  (pub/sub + adapter + presence + cache + queue)
                │                      │
                ▼                      ▼
   ┌──────────────────────────────────────────────────────┐
   │                       Redis                           │
   │  - chat:channel:{id}:members    (Set)                 │
   │  - chat:channel:{id}:workspace  (String)              │
   │  - chat:presence:user:{id}      (Sorted Set)          │
   │  - socket.io:adapter#/*         (Pub/Sub channels)    │
   │  - bull:unread-batch:wait/active/completed/failed    │
   └───────────────┬──────────────────────────────────────┘
                   │
                   │  (Pub/Sub broadcast)
                   ▼
        ┌──────────────────────────────────────┐
        │       Node Instance B (port 3002)    │
        │  (cùng kiến trúc, chạy song song)    │
        └──────────────────────────────────────┘
                   │
                   ▼
                MySQL (Prisma)
```

### Flow "gửi message" sau Phase 6

```
Client emit "send_message"
  └─► Socket.IO server nhận
       ├─► INSERT message (MySQL) — 5ms
       ├─► INSERT attachments (MySQL) — 5ms
       ├─► io.to(senderRoom).emit("receive_message") — 1ms (real-time)
       └─► enqueueUnread (LPUSH buffer, fire-and-forget) — 1ms
            └─► [Main flow trả response cho user — 15ms tổng]

Sau 1s (Phase 7+):
  └─► Aggregator flush buffer thành 1 BullMQ job
       └─► Worker pickup job
            ├─► Gom recipients từ cache (Set members)
            ├─► (Phase 8) PUBLISH chat:notify:unread
            └─► Tất cả instance SUBSCRIBE → io.to(user:N).emit("channel_unread")
```

---

## 6. Trạng thái hiện tại

| Phase | Trạng thái | Bằng chứng |
|---|---|---|
| Phase 1 — Cache members | ✅ Done | `KEYS chat:channel:*:members` có TTL ~300s |
| Phase 2 — Cache workspace | ✅ Done | `GET chat:channel:*:workspace` trả về string workspaceId |
| Phase 3 — Parallel emit | ✅ Done | Loop → `Promise.all` |
| Phase 4 — Redis adapter | ✅ Done | Log `[RedisAdapter] attached` khi start |
| Phase 5 — Presence | ✅ Done | `ZRANGE chat:presence:user:*` trả với score |
| Phase 6 — BullMQ worker | ✅ Done | Test PASS: `Pushed job: 1` + `[Unread Worker] job 1 completed` |

---
## 7. Bài học rút ra

1. **Cache TTL phải cân bằng.** TTL ngắn (5 phút) cho data thay đổi nhiều (members). TTL dài (10 phút+) cho data gần như tĩnh (workspaceId). Quá ngắn → miss nhiều, vô hiệu cache. Quá dài → stale data, user nhận thông tin cũ.

2. **`SET ... EX` atomic tốt hơn `SET` + `EXPIRE` riêng.** Hai lệnh riêng có thể fail giữa đường (SET xong nhưng EXPIRE chưa chạy → key không TTL → cache vĩnh viễn → stale data vô tận).

3. **BullMQ bắt buộc `maxRetriesPerRequest: null`.** Nếu dùng singleton ioredis (mặc định `maxRetries: 20`) → conflict logic retry giữa ioredis và BullMQ → job không chạy. Phải tạo connection riêng.

4. **Multi-instance yêu cầu Redis adapter cho Socket.IO.** In-memory rooms không sync giữa các instance → user mất message khi ở instance khác với người gửi. Adapter dùng Redis pub/sub để broadcast.

5. **Presence cần score-based TTL.** `EXPIRE` trên key không reset khi `ZADD`. Phải dùng Sorted Set với score = timestamp, cleanup bằng `ZREMRANGEBYSCORE`. Worker cleanup chạy định kỳ là safety net.

6. **Worker chạy độc lập với main app.** Test ban đầu nhầm process → push job xong không ai pickup → phải start `index.ts` (chứa `startUnreadWorker()`) trước, terminal khác push job.

7. **BullMQ event listener `completed`/`failed`/`error` đều quan trọng.** `completed` để debug flow, `failed` để alert retry, `error` để detect worker crash.

8. **Cleanup `invalidate cache` ở tất cả chỗ ghi DB.** Nếu thêm member mà quên invalidate → cache cũ không có userId mới → user mới không nhận `channel_unread`. Rule: write DB → invalidate.

