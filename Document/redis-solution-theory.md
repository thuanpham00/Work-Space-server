# Lý thuyết chuyên sâu — Các cơ chế hoạt động của giải pháp Redis

> **Mục đích:** Giải thích **TẠI SAO** giải pháp Redis hoạt động, đào sâu vào các cơ chế nền tảng (distributed systems, CAP, consistency, pub/sub, queue). Phù hợp để review kiến trúc, onboarding senior dev, hoặc training team.
>
> **Phân biệt với 2 file còn lại:**
> - `socket-current-architecture.md` — mô tả hiện trạng + nhược điểm.
> - `redis-realtime-optimization.md` — code triển khai + lý thuyết ngắn gọn (mix HOW + WHY).
> - **File này** — pure lý thuyết, không code, đi sâu vào distributed systems theory.
>
> **Đối tượng:** Backend dev muốn hiểu sâu distributed systems, prepare cho system design interview, hoặc muốn lý luận vững để customize giải pháp.

---

## Mục lục

### Phần 1: Nền tảng lý thuyết
1. [Mô hình phân tán & CAP Theorem](#1-mô-hình-phân-tán--cap-theorem)
2. [In-memory vs Distributed State](#2-in-memory-vs-distributed-state)
3. [Pub/Sub vs Message Queue vs Stream](#3-pubsub-vs-message-queue-vs-stream)

### Phần 2: Các cơ chế cốt lõi
4. [Socket.IO Redis Adapter — chi tiết](#4-socketio-redis-adapter--chi-tiết)
5. [Cache-Aside Pattern](#5-cache-aside-pattern)
6. [BullMQ — Job Queue pattern](#6-bullmq--job-queue-pattern)
7. [Presence với Sorted Set](#7-presence-với-sorted-set)

### Phần 3: Tính chất hệ thống
8. [Consistency model & Eventual consistency](#8-consistency-model--eventual-consistency)
9. [Backpressure & Flow control](#9-backpressure--flow-control)
10. [Failure modes & Resilience](#10-failure-modes--resilience)
11. [Observability — Đo lường hệ phân tán](#11-observability--đo-lường-hệ-phân-tán)

### Phần 4: Lý luận nâng cao
12. [Tại sao KHÔNG chọn Kafka/RabbitMQ/Ably](#12-tại-sao-không-chọn-kafkarabbitmqably)
13. [Khi nào Redis là bottleneck](#13-khi-nào-redis-là-bottleneck)
14. [Lý thuyết scale beyond Redis](#14-lý-thuyết-scale-beyond-redis)

---

## Phần 1: Nền tảng lý thuyết

### 1. Mô hình phân tán & CAP Theorem

#### 1.1. CAP là gì?

CAP Theorem (Eric Brewer, 2000) nói rằng trong một **hệ phân tán** (distributed system), bạn chỉ có thể chọn **tối đa 2 trong 3** tính chất:

| Tính chất | Ý nghĩa | Ví dụ vi phạm |
|-----------|----------|---------------|
| **C**onsistency | Mọi client đọc đều thấy data mới nhất | DB single-master synchronous replication |
| **A**vailability | Mọi request đều được response (không lỗi) | Server luôn trả lời, kể cả data cũ |
| **P**artition tolerance | Hệ thống vẫn hoạt động khi network giữa các node bị cắt | Multi-region |

**Quan trọng:** Trong thực tế mạng Internet **luôn có partition** (packet loss, switch down, DDOS) → **P là bắt buộc**. Bạn chỉ chọn giữa C và A.

#### 1.2. Hệ thống hiện tại chọn gì?

**Hệ thống in-memory Map + single instance:**

```
Consistency: ✅ (chỉ 1 node, không cần sync)
Availability: ❌ (nếu node chết → downtime)
Partition: ✅ (không có partition vì 1 node)
→ CP: consistency + partition (vì chỉ 1 node nên tự nhiên đạt được)
```

**Giải pháp Redis chọn gì?**

```
Consistency: ❌ (eventual consistency cho cache, có thể stale vài giây)
Availability: ✅ (request luôn được response)
Partition: ✅ (Redis cluster chịu được node fail)
→ AP: availability + partition, chấp nhận eventual consistency
```

#### 1.3. Tại sao CP không phù hợp cho chat?

Chat là hệ thống **real-time**, user không chịu được delay. Nếu Redis down → toàn bộ socket ngừng hoạt động → user phải reload → mất engagement.

→ Trade-off: chấp nhận **vài giây eventual consistency** để giữ **availability 99.99%**.

#### 1.4. PACELC — refinement của CAP

PACELC mở rộng CAP: khi **không có partition** (bình thường), hệ thống vẫn phải chọn giữa latency và consistency.

```
PC/EC: khi partition → consistency, khi bình thường → consistency
PA/EL: khi partition → availability, khi bình thường → latency (ưu tiên tốc độ)
```

Hệ thống này thuộc **PA/EL**: ưu tiên latency (chat cần real-time), chấp nhận consistency bình thường (DB là source of truth, cache chỉ là read-through).

---

### 2. In-memory vs Distributed State

#### 2.1. Tại sao in-memory state hấp dẫn?

```
Truy cập: ~100ns (L1/L2 cache của CPU)
Không cần network round-trip
Đơn giản, ít moving parts
```

**Trade-off (chỉ dùng được khi):**
- ✅ Single instance.
- ✅ Dữ liệu có thể mất khi restart.
- ✅ State size < memory limit của 1 process.

#### 2.2. Khi nào phải distributed?

Khi xuất hiện bất kỳ điều nào:
- 🔴 Cần chạy nhiều instance (scale ngang).
- 🔴 State phải survive restart (zero-downtime deploy).
- 🔴 Dữ liệu lớn hơn memory 1 node.

**Distributed state trade-off:**
```
Latency: +0.5-2ms (network hop)
Complexity: +10x (consensus, replication, failure)
Cost: +managed service fee
```

#### 2.3. Cấu trúc dữ liệu Redis được chọn vì lý do gì?

| Cấu trúc | Use case trong giải pháp | Lý do chọn |
|----------|--------------------------|------------|
| **String** | `channel:${id}:workspace` → số | O(1) read/write, SET với EX |
| **Set** | `channel:${id}:members` → userIds | O(1) SADD/SMEMBERS, không cần order |
| **Sorted Set** | `presence:user:${id}` → socketIds theo timestamp | O(log N) ZADD, range query theo score |
| **Hash** | (optional) `user:${id}:profile` | Field-level read, tiết kiệm memory |
| **List** | `chat:unread:buffer` | O(1) LPUSH, FIFO order, dùng làm buffer |
| **Pub/Sub channel** | `chat:notify:unread` | Broadcast real-time, fire-and-forget |
| **Stream** | (optional) thay BullMQ | Persistence + replay |

---

### 3. Pub/Sub vs Message Queue vs Stream

#### 3.1. So sánh 3 cơ chế

| Tính chất | Pub/Sub | Message Queue (BullMQ) | Stream (Kafka/Redis Stream) |
|-----------|---------|------------------------|----------------------------|
| **Delivery guarantee** | At-most-once | At-least-once (với retry) | Exactly-once (với idempotent producer) |
| **Persistence** | ❌ Không lưu | ✅ Lưu trong Redis (configurable) | ✅ Lưu disk |
| **Replay** | ❌ Không | ❌ (BullMQ job lưu nhưng khó replay) | ✅ Có thể đọc lại |
| **Consumer groups** | ❌ Mọi subscriber nhận hết | ✅ Competing consumers (chia job) | ✅ Competing consumers |
| **Throughput** | Rất cao (no persist) | Trung bình | Rất cao |
| **Latency** | < 1ms | 10-50ms (qua worker pickup) | 5-20ms |

#### 3.2. Khi nào dùng gì trong hệ thống?

```
┌─────────────────────────────────────────────────┐
│ Use case                │ Cơ chế   │ Tại sao    │
├─────────────────────────┼───────────┼────────────┤
│ Broadcast receive_msg   │ Pub/Sub   │ Real-time, │
│  cross-instance         │ (via      │ ephemeral, │
│                         │  Adapter) │ không cần  │
│                         │           │ persist    │
├─────────────────────────┼───────────┼────────────┤
│ Unread batch processing │ Queue     │ Cần retry, │
│                         │ (BullMQ)  │ persist,   │
│                         │           │ batching   │
├─────────────────────────┼───────────┼────────────┤
│ Notification cross-     │ Pub/Sub   │ Real-time  │
│  service                │ (custom)  │ trigger,   │
│                         │           │ throwable  │
├─────────────────────────┼───────────┼────────────┤
│ Audit log / replay      │ Stream    │ Compliance,│
│                         │ (optional)│ replay cần │
│                         │           │ thiết      │
└─────────────────────────────────────────────────┘
```

#### 3.3. Tại sao KHÔNG dùng Stream cho unread?

- Stream consumer phải maintain offset → state phức tạp.
- Batch processing chỉ cần "xử lý 1 lần", không cần replay.
- BullMQ built-in có rate-limit, retry, dead-letter → tiết kiệm code.

→ **KISS principle**: chọn tool đơn giản nhất đủ dùng.

---

## Phần 2: Các cơ chế cốt lõi

### 4. Socket.IO Redis Adapter — chi tiết

#### 4.1. Vấn đề multi-instance rooms

Socket.IO lưu room membership trong memory của mỗi Node instance:

```
Instance A: rooms = Map {
  "channel:10" → Set { socket_A1 },
  "user:15"    → Set { socket_A1 }
}

Instance B: rooms = Map {
  "channel:10" → Set { socket_B1 },
  "user:15"    → Set { socket_B1 }
}

io.to("user:15").emit("ping") ở Instance A
→ Chỉ socket_A1 nhận
→ socket_B1 KHÔNG nhận ← BUG
```

#### 4.2. Cách Adapter sync rooms

Khi attach `@socket.io/redis-adapter`, nó wrap `Server.adapter` (interface) với `RedisAdapter`. Khi Socket.IO gọi các method như `broadcast`, `fetchSockets`, nó không đi thẳng vào local Map nữa.

**Cấu trúc Redis channel:**

```
socket.io:adapter#<namespace>#<room>   ← per-room broadcast
socket.io:#<namespace>#                ← all rooms in namespace
socket.io:adapter#<namespace>#requests ← request-response (1 lần 1 instance)
```

**Ví dụ flow khi `io.to("channel:10").emit("hi", payload)`:**

```
1. Adapter nhận broadcast request
2. Look up local sockets in "channel:10" → emit cho socket_A1
3. Redis PUBLISH "socket.io:adapter#/channel:10#" payload
4. Redis fanout tới tất cả subscribers (Instance B, C, D...)
5. Mỗi instance nhận payload
6. Mỗi instance look up local sockets in "channel:10" → emit
7. Kết quả: tất cả sockets trong channel nhận event
```

**Optimizations:**
- "Room with no local sockets" → skip local emit, chỉ publish.
- Custom `key` prefix để namespace nhiều adapter.

#### 4.3. Request-response: `fetchSockets`

Khi cần biết "có bao nhiêu socket trong room X across all instances":

```
1. Instance A: gọi io.in("room:X").fetchSockets()
2. Adapter: gửi request message + unique requestId
   → PUBLISH "socket.io:adapter#/requests"
3. Tất cả instances nhận, đếm local sockets, reply
4. Adapter tổng hợp responses, resolve promise
```

→ Đảm bảo request đến đúng 1 instance (round-robin hoặc first-responder).

#### 4.4. Failure modes của Adapter

| Failure | Behavior | Mitigation |
|---------|----------|------------|
| Redis down | Emit local vẫn chạy, cross-instance broken | Multi-AZ Redis, circuit breaker |
| Redis restart | Miss event trong lúc restart | Stuck trên local emit (cũng broken) → reconnect logic ở client |
| Network partition giữa Node và Redis | Node retry, queue local | Nếu partition > timeout, log warning |
| Redis chậm | Latency tăng đồng đều | Set `requestsTimeout`, monitor p99 |

#### 4.5. Tại sao KHÔNG sticky session với IP_hash?

Có thể dùng sticky session (cùng IP → cùng instance) → tránh broadcast. Nhưng:
- Mobile user thay đổi IP liên tục → mất session.
- Load balancer phải làm L4 routing thay L7.
- Một instance chết → reconnect phải re-route toàn bộ.

→ Redis Adapter linh hoạt hơn, dù có thêm network hop.

---

### 5. Cache-Aside Pattern

#### 5.1. Định nghĩa

Cache-Aside (còn gọi là "Lazy Loading") là pattern phổ biến nhất cho read-heavy workload:

```
READ:
  key in cache?
    YES → return cached value
    NO  → query DB → set cache → return

WRITE:
  write DB
  invalidate cache (DEL key, không SET)
  (lần đọc tiếp theo sẽ miss → query lại → set lại cache)
```

#### 5.2. Tại sao KHÔNG Write-Through?

```
Write-Through:
  SET cache
  Write DB
  → Nếu DB write fail, cache đã có data mới nhưng DB chưa → INCONSISTENT
  → Phải rollback cache, phức tạp
```

```
Cache-Aside:
  Write DB first
  DEL cache (idempotent, không cần rollback)
  → DB là source of truth
  → Cache sẽ tự rebuild khi cần
```

→ **Cache-Aside đơn giản hơn, an toàn hơn** khi DB là nguồn sự thật.

#### 5.3. Thundering herd / Cache stampede

Khi hot key expire, **nhiều request đồng thời** đều miss → tất cả query DB:

```
t=300s:  cache EXPIRE
t=300.01s: 100 requests miss cache → 100 query DB → overload
```

**Các giải pháp:**

| Kỹ thuật | Cách hoạt động | Trade-off |
|----------|----------------|-----------|
| **Lock** | Chỉ 1 thread được query DB, các thread khác đợi | Phức tạp, lock contention |
| **Probabilistic early refresh** | Cron job refresh trước khi expire | Cần scheduler |
| **TTL jitter** | Stagger TTL ± random % | Đơn giản, không triệt để |
| **Stale-while-revalidate** | Serve stale + async refresh | Serve data cũ trong vài giây |

**Trong hệ thống này:** Dùng **TTL jitter** (đơn giản, đủ dùng với scale hiện tại).

#### 5.4. Cache invalidation strategies

| Strategy | Khi nào dùng | Pattern |
|----------|--------------|---------|
| **TTL only** | Data thay đổi ít, chấp nhận stale | `SET key value EX 300` |
| **Event-based** | Cần freshness ngay lập tức | Sau write → `DEL key` |
| **Hybrid** | Best of both | TTL + DEL sau write (giải pháp này) |

#### 5.5. Distributed cache invalidation

Khi nhiều Node instance cùng ghi vào DB, ai invalidate?

```
Instance A write DB → DEL cache (ở Instance A)
Instance B write DB → DEL cache (ở Instance B)
→ Cả 2 đều DEL cùng key → idempotent, OK
```

Nếu DB write ở instance khác với instance serve read:

```
Instance A write DB → DEL cache
Instance B read → miss → query DB → set cache (với value cũ nếu Instance B đọc trước khi A write xong)
```

→ Trong trường hợp này, eventual consistency cho phép stale trong vài ms. Acceptable.

---

### 6. BullMQ — Job Queue pattern

#### 6.1. Tại sao Queue?

Khi có tác vụ:
- Tốn thời gian (DB write nặng, external API call).
- Cần retry khi fail.
- Có thể chờ được (không real-time critical).
- Có thể batch nhiều cái lại.

→ **Đẩy sang Queue, main flow không bị block**.

#### 6.2. Producer-Consumer pattern

```
┌──────────┐         ┌──────────┐         ┌──────────┐
│ Producer │────►────│  Queue   │────►────│ Consumer │
│ (API)    │  enqueue│ (Redis)  │  pickup │ (Worker) │
└──────────┘         └──────────┘         └──────────┘
   ↑                                          │
   └─────────── result / DLQ ──────────────────┘
```

**Producer:** Thêm job vào queue. **Không đợi** (fire-and-forget hoặc đợi id).
**Consumer:** Worker liên tục poll queue, xử lý job.

#### 6.3. Competing consumers

Nhiều worker cùng consume 1 queue → Redis đảm bảo mỗi job chỉ đi đến 1 worker (atomic RPOPLPUSH hoặc equivalent).

→ **Horizontal scaling cho worker process**.

#### 6.4. Stalled job detection

BullMQ dùng cơ chế "heartbeat" để phát hiện worker chết:

```
Worker pickup job → set "stalled" timeout (default 30s)
Mỗi lần worker gọi job.updateProgress() → reset timeout
Nếu quá timeout → job tự move về "active" của worker khác
```

→ **Self-healing**: Worker crash giữa chừng → job không bao giờ bị stuck.

#### 6.5. Exponential backoff

```
Failure 1 → wait 1s → retry
Failure 2 → wait 2s → retry
Failure 3 → wait 4s → retry
Failure 4 → DLQ (manual intervention)
```

**Lý do:** Nếu DB tạm thời quá tải, retry ngay lập tức chỉ làm tệ hơn. Exponential backoff giãn cách → DB có thời gian recover.

#### 6.6. Memory leak prevention

BullMQ lưu job trong Redis → phải dọn:

```typescript
defaultJobOptions: {
  removeOnComplete: { count: 1000 },  // giữ 1000 job gần nhất
  removeOnFail: { count: 5000 }
}
```

→ Queue không phình vô hạn.

#### 6.7. Khi nào Queue KHÔNG phù hợp?

- Cần response đồng bộ (sync API call) → phải await trực tiếp.
- Latency cực thấp (< 10ms) → overhead pickup/processing job.
- 1 lần / không lặp lại → overkill.

---

### 7. Presence với Sorted Set

#### 7.1. Tại sao Sorted Set, không phải Set thường?

**Set thường:**
```
SADD presence:user:15 "socket_A1"
SADD presence:user:15 "socket_B1"
SMEMBERS presence:user:15 → ["socket_A1", "socket_B1"]
```

❌ Không biết socket nào "cũ" (idle) → không TTL per-member.

**Sorted Set:**
```
ZADD presence:user:15 1697000000 "socket_A1"   ← score = timestamp
ZADD presence:user:15 1697000030 "socket_B1"
ZRANGEBYSCORE presence:user:15 <now-60s> → [] ← idle sockets
```

✅ Mỗi member có **score** (timestamp) → biết được "lần cuối heartbeat" → TTL per-member.

#### 7.2. Score-based expiration

```redis
ZREMRANGEBYSCORE key -inf <threshold>  ← Xoá members có score cũ
```

Nếu set rỗng sau khi xoá → DEL key → tiết kiệm memory.

#### 7.3. Tại sao KHÔNG dùng EXPIRE trên member?

EXPIRE hoạt động trên **key**, không trên member của sorted set. Mỗi socket sẽ cần key riêng → không khả thi.

#### 7.4. Clock skew problem

Sorted Set dùng timestamp làm score → các Node instance dùng đồng hồ khác nhau có thể score "không khớp".

**Giải pháp:**
- Dùng Redis `TIME` command thay vì Node `Date.now()` → đồng bộ giữa instances.
- Hoặc chấp nhận skew nhỏ (vài giây trong cùng DC).

#### 7.5. Memory cost

Mỗi member trong Sorted Set tốn ~50 bytes (key + score + value).

```
10,000 users × 2 sockets average × 50 bytes = 1MB
100,000 users × 2 sockets × 50 bytes = 10MB
→ Acceptable cho most cases
```

Nếu scale 1M+ users → cần Redis cluster sharding.

---

## Phần 3: Tính chất hệ thống

### 8. Consistency model & Eventual consistency

#### 8.1. Consistency spectrum

```
Strong ──────────────────────────────────────── Weak
  │
  ├─ Linearizability (đọc thấy write mới nhất)
  ├─ Sequential consistency
  ├─ Causal consistency
  ├─ Read-your-writes (đọc lại thấy write của mình)
  ├─ Eventual consistency (cuối cùng sẽ đồng bộ)
  │
  └─ (chỉ là không đảm bảo)
```

#### 8.2. Hệ thống ở đâu trên spectrum?

| Tầng dữ liệu | Consistency | Ví dụ |
|---------------|-------------|------|
| **DB write** | Strong (single master) | Message insert |
| **Cache read** | Eventual (stale 5 min) | Channel members |
| **Presence** | Eventual (stale 60s) | User online |
| **BullMQ job** | At-least-once (có thể dup) | Unread sync |
| **Socket emit** | At-most-once | receive_message (miss OK) |

→ **Hệ thống chấp nhận nhiều mức eventual consistency**, trade-off để có low latency.

#### 8.3. Tại sao chat chấp nhận eventual consistency?

- User gửi message → phải hiện ngay (real-time).
- Read state (đã đọc / chưa) → có thể trễ vài giây.
- Unread count → có thể trễ 1-2s.
- Online status → có thể trễ 60s.

→ Chỉ **message content** cần real-time. Mọi thứ khác eventual.

#### 8.4. Idempotency

Vì một số operation có thể bị duplicate (BullMQ retry, network re-send), receiver phải **idempotent**:

```typescript
// Trong unread worker:
const seenMessageIds = new Set()
for (const event of events) {
  if (seenMessageIds.has(event.messageId)) continue  // skip duplicate
  seenMessageIds.add(event.messageId)
  // process...
}
```

Hoặc dùng **database unique constraint** làm safety net:

```sql
CREATE UNIQUE INDEX uniq_unread 
ON unread_messages(user_id, channel_id, message_id);
```

#### 8.5. CAP — Consistency có bao giờ cần tuyệt đối?

Có — cho **financial transaction**, **inventory count**. Cho chat? **Không**.

Đánh đổi:
- ✅ Real-time: chấp nhận được.
- ❌ Real-time + chính xác tuyệt đối: không khả thi về engineering cost.

---

### 9. Backpressure & Flow control

#### 9.1. Backpressure là gì?

Khi consumer xử lý chậm hơn producer → **queue tăng vô hạn** → cuối cùng crash.

**Áp dụng cho Socket.IO:**

```
Client A gửi 1000 msg/giây
Server broadcast 1000 msg → 1000 clients
Mỗi client send ack chậm → server emit buffer đầy → memory leak
```

#### 9.2. Các cơ chế backpressure trong giải pháp

| Cơ chế | Vị trí | Tác dụng |
|--------|--------|----------|
| **Rate limit trên BullMQ worker** | `unread.worker.ts` | Tối đa 10 job/s, backpressure worker |
| **Buffer + flush interval** | `unread.aggregator.ts` | Gom event, giảm tải job queue |
| **Socket.IO bufferSize** | Built-in | Socket tự pause nếu TCP buffer đầy |
| **Connection limit** | `express-rate-limit` | Giới hạn HTTP API rate |
| **Per-socket rate limit** | TBD (TODO) | Cần thêm middleware |

#### 9.3. TCP backpressure (built-in)

Socket.IO dùng TCP → TCP có flow control native:

```
Sender: pause nếu window = 0 (receiver không kịp xử lý)
Sender: resume khi window > 0
```

→ **Long flow control chuỗi**: Application → Socket → TCP → Network → Receiver.

#### 9.4. Circuit breaker pattern

Khi Redis down → không nên retry liên tục (làm tăng tải):

```
CLOSED (bình thường)
   ↓ fail N lần
OPEN (block request, không gọi Redis)
   ↓ sau timeout
HALF_OPEN (thử 1 request)
   ├─ success → CLOSED
   └─ fail → OPEN
```

→ Thư viện `opossum` để implement.

---

### 10. Failure modes & Resilience

#### 10.1. Phân loại failure

| Failure | Tần suất | Tác động |
|---------|----------|----------|
| **Redis crash** | Rất hiếm (managed) | Adapter broken, fallback local emit |
| **DB connection drop** | Thỉnh thoảng | Prisma retry, request fail |
| **Node crash** | Rất hiếm | Mất in-memory state, Redis giữ |
| **Network partition Node↔Redis** | Hiếm | Emit chỉ local, cross-instance broken |
| **Network partition Node↔DB** | Thỉnh thoảng | DB timeout, request fail |
| **Client disconnect** | Thường xuyên | Cleanup presence + room |

#### 10.2. Resilience strategies

**Mỗi layer phải chịu được failure của layer dưới:**

```
Client disconnect: Socket.IO internal cleanup (built-in)
↓
Node crash: Redis adapter giữ rooms của instance khác
↓
Redis crash: 
  - Adapter: broadcast fail, cross-instance broken
  - BullMQ: jobs queue lại trong Redis khi recover
  - Cache: rebuild on next read
↓
DB down:
  - Prisma retry pool
  - Express timeout 30s
  - 503 response
  - Circuit breaker mở (sau N fail)
```

#### 10.3. Graceful degradation

Khi Redis down, hệ thống vẫn hoạt động (một số tính năng degraded):

| Tính năng | Khi Redis OK | Khi Redis down |
|-----------|--------------|----------------|
| Message trong cùng instance | ✅ | ✅ (local emit) |
| Message sang instance khác | ✅ | ❌ (mất) |
| Unread notification | ✅ (deferred 1s) | ❌ (fail silently) |
| Presence | ✅ | ❌ (vẫn dùng in-memory fallback) |
| Channel member cache | ✅ | ⚠️ (fallback DB query) |

#### 10.4. Idempotent recovery

Khi crash + restart:

1. Redis recover → BullMQ tự replay failed jobs.
2. Redis adapter tự resubscribe.
3. Presence data có thể stale → accept (TTL sẽ dọn).
4. Cache trống → serve miss + rebuild.

→ **Stateless design** (state trong Redis, không trong Node) → restart an toàn.

---

### 11. Observability — Đo lường hệ phân tán

#### 11.1. 3 loại signal (Google SRE)

| Signal | Đo gì | Tool |
|--------|-------|------|
| **Logs** | Sự kiện discrete | Pino, Winston → ELK |
| **Metrics** | Số liệu tổng hợp | Prometheus → Grafana |
| **Traces** | Flow request xuyên qua nhiều service | OpenTelemetry → Jaeger |

#### 11.2. Metrics quan trọng cho hệ thống chat

**Socket layer:**
- `socket_io_connected` (gauge)
- `socket_io_events_in_total` (counter, theo event name)
- `socket_io_events_out_total` (counter)
- `socket_io_ack_latency_seconds` (histogram)

**Redis layer:**
- `redis_commands_total` (counter, theo command)
- `redis_latency_seconds` (histogram)
- `redis_memory_used_bytes` (gauge)
- `bullmq_queue_length` (gauge, theo queue)

**Application:**
- `http_request_duration_seconds` (histogram)
- `db_query_duration_seconds` (histogram, theo query name)
- `unread_events_processed_total` (counter)

#### 11.3. Distributed tracing

Trace 1 message từ client → server → DB → broadcast → client khác:

```
Trace ID: abc123

[Span: client.receive_message] 50ms
  [Span: server.handle_send] 45ms
    [Span: db.message.insert] 5ms
    [Span: socket.broadcast] 30ms
      [Span: redis.publish] 1ms
    [Span: enqueue_unread] 0.5ms
      [Span: redis.lpush] 0.5ms
```

→ Pinpoint đâu là bottleneck.

#### 11.4. Logging best practices

```typescript
// ❌ Bad
console.log('user 15 joined')

// ✅ Good (structured)
logger.info({
  event: 'socket.join_channel',
  userId: 15,
  channelId: 10,
  traceId: req.id,
  ts: Date.now()
}, 'User joined channel')
```

**Structured logs** parse được bởi ELK/Loki → query dễ.

#### 11.5. SLI/SLO/SLA

| Metric | Target (SLO) | Error budget |
|--------|--------------|--------------|
| **Availability** | 99.9% (≈ 43 min downtime/tháng) | 43 min/tháng |
| **p99 latency send_message** | < 500ms | 0.1% request vượt |
| **p99 latency receive** | < 100ms | 0.1% client nhận trễ |
| **Miss rate broadcast** | < 0.01% | cross-instance broadcast fail |

---

## Phần 4: Lý luận nâng cao

### 12. Tại sao KHÔNG chọn Kafka/RabbitMQ/Ably?

#### 12.1. Kafka

**Khi nào nên chọn:**
- Throughput > 100K events/s.
- Cần event sourcing, replay toàn bộ history.
- Multi-datacenter replication.
- Compliance yêu cầu audit trail dài hạn.

**Tại sao KHÔNG cho case này:**
- ❌ Operational overhead lớn: Zookeeper / KRaft controller.
- ❌ Team learning curve cao.
- ❌ Cost: 3 broker tối thiểu = $200-500/tháng.
- ❌ Overkill cho < 10K events/s.

**Khi nào migrate:** Khi vượt 100K CCU hoặc cần event sourcing.

#### 12.2. RabbitMQ

**Khi nào nên chọn:**
- AMQP protocol cần thiết.
- Complex routing (topic exchange, fanout, etc.).
- On-premise không thể dùng Kafka.

**Tại sao KHÔNG:**
- ❌ Latency cao hơn Redis (5-20ms vs <1ms).
- ❌ Scaling khó (cluster mode phức tạp).
- ❌ Channel pattern không cần routing phức tạp.

#### 12.3. Ably / Pusher

**Khi nào nên chọn:**
- Team nhỏ, không muốn vận hành infrastructure.
- Global user base, cần low latency everywhere.
- Sẵn sàng trả tiền theo message.

**Tại sao KHÔNG cho project này:**
- ❌ Vendor lock-in: khó migrate.
- ❌ Data ra khỏi hệ thống (regulatory concern).
- ❌ Chi phí tăng theo scale (không predictable).
- ❌ Không customize được protocol.

#### 12.4. Decision matrix

| Tiêu chí | Redis ✅ | Kafka | RabbitMQ | Ably |
|----------|--------|-------|----------|------|
| Throughput | ~100K/s | > 1M/s | ~50K/s | Unlimited |
| Latency | < 1ms | 5-20ms | 5-20ms | 50-100ms (geo) |
| Ops complexity | Thấp | Cao | Trung bình | Thấp (managed) |
| Cost (10K/s) | $50 | $500+ | $200 | $300-1000 |
| Multi-region | Khó | Tốt | Khó | Tốt |
| Vendor lock-in | ❌ | ❌ | ❌ | ✅ |
| Persistence | Optional | ✅ | Optional | N/A |

---

### 13. Khi nào Redis là bottleneck

#### 13.1. Limits của Redis

| Resource | Limit (typical) | Mitigation |
|----------|-----------------|------------|
| **Single instance throughput** | ~100K-200K ops/s | Cluster, shard theo key |
| **Memory** | 32GB practical | Cluster shard, TTL aggressive |
| **Network bandwidth** | 1-10 Gbps | Sharding, batch |
| **Pub/Sub fanout** | O(N) per subscriber | Adapter room design |

#### 13.2. Cluster / sharding

Khi single Redis không đủ:
- **Redis Cluster** (16K slots, auto-shard).
- Hash key: `chat:{channel:10:members}` → slot 5xxx.
- Cross-slot operations (multi-key) không được phép.

#### 13.3. Tiered storage

Hot data (realtime) → Redis.
Cold data (history > 24h) → DB / S3.

```
Message realtime: Redis (chỉ metadata, không lưu full content)
Message persistent: MySQL
Presence: Redis (TTL)
History query: MySQL indexed
Attachment: S3 + CDN
```

#### 13.4. Monitoring Redis

Critical metrics:
- `used_memory` / `maxmemory` → sắp đầy?
- `instantaneous_ops_per_sec` → đang tải cao?
- `connected_clients` → quá nhiều connection?
- `keyspace_hits` / `keyspace_misses` → cache hit rate?
- `pubsub_channels` / `pubsub_patterns` → fanout đang lớn?
- `slowlog` → query chậm?

---

### 14. Lý thuyết scale beyond Redis

#### 14.1. Scale layers

```
Layer 1: Single Redis (1 instance)
  ↓ insufficient
Layer 2: Redis Cluster (sharded, multi-node)
  ↓ insufficient
Layer 3: Multi-region Redis (geo-replicated)
  ↓ insufficient
Layer 4: Kafka + Redis (Kafka cho durable event log)
  ↓ insufficient
Layer 5: CRDT / Operational Transform (collaborative editing)
```

#### 14.2. Multi-region

Challenge: same user ở 2 region → conflict resolution.

Pattern:
- **Master-master CRDT**: Last-write-wins + vector clock.
- **Active-passive**: Region 1 active, Region 2 standby.
- **Geo-DNS**: Route user gần nhất → trade-off consistency.

#### 14.3. WebSocket at hyperscale

Discord (case study):
- 11M+ concurrent users.
- 700+ guilds per user.
- Custom gateway protocol (KHÔNG dùng Socket.IO).
- Stateful gateway cluster với sharding theo guild.
- Hàng triệu msg/s → Kafka + Cassandra.

→ Khi scale đến mức này, phải **tự build** thay vì dùng off-the-shelf.

#### 14.4. Cost optimization

Bandwidth thường là cost lớn nhất cho chat:

```
1 message text ở channel 1000 members:
  Server → 1000 clients
  Bandwidth: 1000 × 100 bytes = 100KB
  100 msg/s × 100KB = 10MB/s = 3TB/tháng
  
Mitigation:
- Compression (gzip/zstd)
- Batching nhiều msg trong 1 frame
- WebSocket compression extension (`permessage-deflate`)
```

---

## Tổng kết lý thuyết

### Các concept cốt lõi đã học

| Concept | Áp dụng |
|---------|---------|
| **CAP theorem** | Lý do chọn AP cho chat |
| **Cache-Aside** | Pattern cache channel members |
| **Cache invalidation** | TTL + explicit DEL |
| **Cache stampede** | TTL jitter |
| **Pub/Sub** | Socket.IO adapter cross-instance |
| **Producer-Consumer** | BullMQ worker |
| **Idempotency** | Handle BullMQ retry duplicate |
| **Backpressure** | Rate-limit BullMQ, TCP flow control |
| **Eventual consistency** | Chấp nhận stale cache/presence |
| **Graceful degradation** | Fallback khi Redis down |
| **Stateless design** | Restart an toàn vì state ở Redis |
| **Observability** | Logs + Metrics + Traces |

### Mermaid: Tổng hợp luồng

```
Client A                  Node A             Redis              Node B             Client B
  │                         │                  │                  │                   │
  │ send_message            │                  │                  │                   │
  │ ──────────────────────► │                  │                  │                   │
  │                         │ message.create() │                  │                   │
  │                         │ ───DB──►         │                  │                   │
  │                         │ localEmit(ch:10) │                  │                   │
  │                         │ ──► A            │                  │                   │
  │                         │ PUBLISH ch:10    │                  │                   │
  │                         │ ──────────────►  │ fanout           │                   │
  │                         │                  │ ─────────────►  │                   │
  │                         │                  │                  │ localEmit(ch:10)  │
  │                         │                  │                  │ ──► B             │
  │                         │ enqueueUnread()  │                  │                   │
  │                         │ ───LPUSH──►     │                  │                   │
  │                         │                  │ aggregator(1s)   │                   │
  │                         │                  │ ──BullMQ─►       │                   │
  │                         │                  │   worker         │                   │
  │                         │                  │   PUBLISH notify │                   │
  │                         │                  │ ──────────────►  │ subscriber        │
  │                         │                  │                  │ io.to(user:*)     │
  │                         │                  │                  │ ──► B (unread)    │
```

---

## Đọc thêm (nếu muốn đào sâu)

| Chủ đề | Resource |
|--------|----------|
| CAP / PACELC | "Designing Data-Intensive Applications" — ch. 5, 9 (Martin Kleppmann) |
| Socket.IO scaling | https://socket.io/docs/v4/redis-adapter/ |
| Redis Pub/Sub | https://redis.io/docs/manual/pubsub/ |
| BullMQ patterns | https://docs.bullmq.io/patterns |
| Cache patterns | "Caching at Reddit" — engineering blog |
| Distributed tracing | OpenTelemetry docs |
| Discord scaling | https://discord.com/blog/how-discord-handles-push-request-bursts |

---

> **Tác giả:** Backend team
> **Ngày:** 2026-10-17
> **Liên quan:**
> - `socket-current-architecture.md` — mô tả hiện trạng
> - `redis-realtime-optimization.md` — code + lý thuyết ngắn gọn
> - File này — pure lý thuyết chuyên sâu
