# Phase 5: Reconcile Job (Tự Sửa Counter Lệch)

> ⏱️ **Thời gian:** 2–2.5 giờ
> 🎯 **Mục tiêu:** Redis lệch DB → tự sửa trong ≤5 phút. Badge luôn đúng dù Redis mất dữ liệu.
> 📍 **Vị trí code:** `src/services/unread.services.ts` (mới), `src/queues/reconcile.worker.ts` (mới), `src/index.ts`

---

## 🎯 Vấn đề

Sau Phase 3–4, **Redis là nguồn sự thật** cho unread count. Nhưng Redis có thể lệch DB:

| Nguyên nhân lệch | Ví dụ | Hậu quả |
|---|---|---|
| Redis restart mất dữ liệu | AOF chưa bật / bật `no` | Tất cả count về 0 → **badge biến mất** |
| Message tạo ngoài socket path | Thêm REST endpoint gửi tin | Thiếu badge cho user đó |
| `incrementUnreadBatch` fail | Redis nghẽn giữa chừng | Thiếu count |
| Logic đọc (`leave_channel`) bị bỏ sót | Bug trong code | Count tồn đọng |
| DB bị sửa tay / rollback | Migration | Lệch 2 chiều |

→ Cần một **cơ chế tự lành**: định kỳ tính lại count từ DB và ghi đè Redis.

---

## 📚 Lý thuyết tối thiểu

### Reconcile là gì?

```
Reconcile = đối chiếu 2 nguồn dữ liệu và đồng bộ về 1 nguồn chuẩn.

DB (chân lý)  ──đối chiếu──▶  Redis (bản cache)  ──ghi đè──▶  Redis
```

Giống cách `git rebase`: nếu cache lệch thì reset về source of truth.

### Vì sao không chạy reconcile mỗi lần gửi tin?

| Cách | Tần suất | Query DB | Độ trễ sửa lệch |
|---|---|---|---|
| Reconcile mỗi message | Mỗi tin | N+1 mỗi tin | Ngay | ❌ Phá vỡ mục tiêu 0 query |
| **Reconcile định kỳ** | Mỗi 5 phút | ~3/channel/5 phút | ≤5 phút | ✅ |

### Chỉ reconcile channel "đang hoạt động"

Không thể reconcile TẤT CẢ channel (có thể hàng nghìn). Cần biết channel nào đang có message gần đây.

→ Dùng **ZSET** làm "danh sách channel nóng":

```
Key:    chat:unread:active
Type:   Sorted Set
Member: channelId
Score:  timestamp (ms) của lần hoạt động gần nhất
```

Mỗi lần có message trong channel → `ZADD unread:active <now> <channelId>` (1 lệnh, O(log N)).

Reconcile → `ZRANGEBYSCORE unread:active -inf <now - 10 phút>` → lấy channel đang hoạt động.

### Vì sao cần "ngưỡng 10 phút"

```
Reconcile chạy mỗi 5 phút.
Lấy channel hoạt động trong 10 phút gần nhất → đảm bảo không sót channel
vừa ngừng hoạt động (giữa 2 lần reconcile).
```

---

## 🔧 Bước 1: Thêm ZSET tracking vào `unread.services.ts`

```typescript
const activeKey = 'unread:active'

// TTL không dùng cho ZSET — tự dọn bằng cách chỉ giữ channel hot.
// Dùng ZREMRANGEBYSCORE để xoá channel quá 1 ngày.
const ACTIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 1 ngày

/**
 * Đánh dấu channel là "đang hoạt động" (có message mới).
 * Gọi mỗi lần increment counter.
 */
export const markChannelActive = async (channelId: string | number): Promise<void> => {
  await redis.zadd(activeKey, Date.now(), String(channelId))
}

/**
 * Lấy danh sách channel hoạt động trong khoảng thời gian gần đây.
 */
export const getActiveChannelIds = async (sinceMs: number): Promise<string[]> => {
  const ids = await redis.zrangebyscore(activeKey, sinceMs, '+inf')
  return ids
}

/**
 * Dọn channel quá lâu không hoạt động khỏi ZSET.
 */
export const cleanupActiveChannels = async (): Promise<number> => {
  const cutoff = Date.now() - ACTIVE_MAX_AGE_MS
  const removed = await redis.zremrangebyscore(activeKey, '-inf', cutoff)
  return removed
}
```

### Gọi `markChannelActive` trong write path

`src/socket/utils.ts` → `handleSendMessage`:

```typescript
await incrementUnreadBatch(channelId, recipients)
await markChannelActive(channelId)   // ← thêm
```

Làm tương tự cho `handleSendGif`.

> Có thể gộp vào `incrementUnreadBatch` để tiết kiệm 1 round trip (xem "Tối ưu" bên dưới).

---

## 🔧 Bước 2: Hàm tính count chính xác từ DB (cutoff grouping)

Đưa hàm `getUnreadCounts` (bản DB ở Phase 1) vào `unread.services.ts` để dùng lại:

```typescript
/**
 * Tính unread count từ DB cho nhiều user trong 1 channel.
 * Dùng cho reconcile — KHÔNG dùng trên đường nóng.
 *
 * count(user) = COUNT(messages WHERE channelId = X AND id > lastReadMessageId(user) AND type != 'CONFIG')
 *
 * Gom theo distinct cutoff → số query không phụ thuộc số member.
 */
export const computeUnreadCountsFromDb = async (
  channelId: string | number,
  userIds: number[]
): Promise<Map<number, number>> => {
  const result = new Map<number, number>()
  if (userIds.length === 0) return result

  const bigChannelId = BigInt(channelId)

  // 1. Read state của tất cả user (1 query)
  const readStates = await databaseServices.prisma.channelReadState.findMany({
    where: {
      channelId: bigChannelId,
      userId: { in: userIds.map((id) => BigInt(id)) }
    },
    select: { userId: true, lastReadMessageId: true }
  })

  const cutoffMap = new Map<number, bigint>()
  for (const state of readStates) {
    cutoffMap.set(Number(state.userId), state.lastReadMessageId ?? BigInt(0))
  }

  // 2. Gom distinct cutoff
  const cutoffs = new Set<string>()
  for (const cutoff of cutoffMap.values()) {
    cutoffs.add(cutoff.toString())
  }

  // 3. 1 count query mỗi distinct cutoff (thường chỉ 1–3)
  const countByCutoff = new Map<string, number>()
  await Promise.all(
    [...cutoffs].map(async (cutoffStr) => {
      const count = await databaseServices.prisma.message.count({
        where: {
          channelId: bigChannelId,
          id: { gt: BigInt(cutoffStr) },
          messageType: { not: 'CONFIG' }
        }
      })
      countByCutoff.set(cutoffStr, count)
    })
  )

  // 4. Map userId → count
  for (const userId of userIds) {
    const cutoff = cutoffMap.get(userId) ?? BigInt(0)
    result.set(userId, countByCutoff.get(cutoff.toString()) ?? 0)
  }

  return result
}
```

---

## 🔧 Bước 3: Hàm reconcile 1 channel

```typescript
/**
 * Đối chiếu count của 1 channel giữa DB và Redis, ghi đè Redis.
 *
 * @returns số user bị sửa
 */
export const reconcileChannel = async (channelId: string): Promise<number> => {
  // 1. Lấy member ACTIVE của channel
  const members = await databaseServices.prisma.channelMember.findMany({
    where: {
      channelId: BigInt(channelId),
      status: MemberStatus.ACTIVE
    },
    select: { userId: true }
  })

  const userIds = members.map((m) => Number(m.userId))
  if (userIds.length === 0) return 0

  // 2. Tính count chuẩn từ DB
  const dbCounts = await computeUnreadCountsFromDb(channelId, userIds)

  // 3. Đọc count hiện tại trong Redis
  const redisCounts = await getUnreadCounts(channelId, userIds)

  // 4. Tìm user lệch → ghi đè
  const key = unreadKey(channelId)
  const pipeline = redis.pipeline()
  let fixed = 0

  for (const userId of userIds) {
    const dbCount = dbCounts.get(userId) ?? 0
    const redisCount = redisCounts.get(userId) ?? 0

    if (dbCount !== redisCount) {
      pipeline.hset(key, String(userId), dbCount)
      fixed++
    }
  }

  if (fixed > 0) {
    pipeline.expire(key, UNREAD_TTL)
    await pipeline.exec()
  }

  return fixed
}
```

Cần import `MemberStatus` từ `~/constants/enum`.

---

## 🔧 Bước 4: Tạo `src/queues/reconcile.worker.ts`

Có 2 lựa chọn: dùng BullMQ repeat job, hoặc `setInterval`. Dùng **BullMQ repeat** để nhất quán với hạ tầng hiện có và tự động chạy trên mọi instance (BullMQ đảm bảo chỉ 1 instance chạy mỗi lần).

```typescript
import { Worker, Job } from 'bullmq'
import IORedis from 'ioredis'
import { envConfig } from '~/utils/config'
import { getActiveChannelIds, reconcileChannel, cleanupActiveChannels } from '~/services/unread.services'

// 5 phút
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000

// Lấy channel hoạt động trong 10 phút gần nhất (gấp đôi interval để không sót)
const ACTIVE_LOOKBACK_MS = 10 * 60 * 1000

export const RECONCILE_JOB_NAME = 'reconcile-unread'

export const startReconcileWorker = () => {
  const connection = new IORedis(envConfig.redis_url, { maxRetriesPerRequest: null })

  const worker = new Worker(
    'unread-reconcile',
    async (job: Job) => {
      const since = Date.now() - ACTIVE_LOOKBACK_MS
      const channelIds = await getActiveChannelIds(since)

      if (channelIds.length === 0) {
        return { channels: 0, fixed: 0 }
      }

      let fixed = 0
      for (const channelId of channelIds) {
        try {
          const count = await reconcileChannel(channelId)
          fixed += count
          if (count > 0) {
            console.log(`[Reconcile] channel ${channelId}: fixed ${count} user(s)`)
          }
        } catch (err) {
          console.error(`[Reconcile] channel ${channelId} failed:`, err)
        }
      }

      // Dọn channel quá 1 ngày không hoạt động
      await cleanupActiveChannels()

      console.log(`[Reconcile] done: ${channelIds.length} channels, ${fixed} user(s) fixed`)
      return { channels: channelIds.length, fixed }
    },
    {
      connection,
      concurrency: 1,   // chạy tuần tự để không dồn query DB
      limiter: { max: 1, duration: 60_000 }  // tối đa 1 lần/phút
    }
  )

  worker.on('failed', (job, err) => {
    console.error(`[Reconcile] job ${job?.id} failed:`, err.message)
  })

  return worker
}

/**
 * Đăng ký repeat job (gọi 1 lần khi boot).
 * BullMQ đảm bảo chỉ 1 instance chạy mỗi lần → không cần lock thủ công.
 */
export const scheduleReconcileJob = async () => {
  const { unreadReconcileQueue } = await import('./queue')
  await unreadReconcileQueue.add(
    RECONCILE_JOB_NAME,
    {},
    {
      repeat: { every: RECONCILE_INTERVAL_MS },
      jobId: 'reconcile-unread-repeat',
      removeOnComplete: 100,
      removeOnFail: 100
    }
  )
}
```

---

## 🔧 Bước 5: Thêm queue vào `src/queues/queue.ts`

```typescript
export const unreadReconcileQueue = new Queue('unread-reconcile', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 }
  }
})
```

> Tái sử dụng `connection` sẵn có trong file.

---

## 🔧 Bước 6: Khởi động trong `src/index.ts`

```typescript
import { startReconcileWorker, scheduleReconcileJob } from '~/queues/reconcile.worker'

// Trong hàm start(), sau khi startUnreadWorker():
const reconcileWorker = startReconcileWorker()
await scheduleReconcileJob()
```

Và trong `shutdown()`: `await reconcileWorker.close()`.

---

## 🔧 Bước 7: Đồng bộ read state 2 chiều

Reconcile chỉ sửa **count trong Redis**. Cần chắc chắn `channel_read_states` trong DB cũng đúng.

**Kiểm tra:** `upsertChannelReadState` được gọi ở `join_channel` + `leave_channel` (Phase 2) → DB read state đúng.

**Ngoại lệ:** nếu `upsertChannelReadState` lỗi (DB lỗi) → DB stale → reconcile tính count sai → ghi sai vào Redis.

→ Đây là trường hợp hiếm; chấp nhận được (reconcile lần sau sẽ sửa khi DB OK).

**Tùy chọn nâng cao:** reconcile cũng sửa `channel_read_states` nếu phát hiện lệch. Nhưng cần cẩn thận: read state là dữ liệu **user action**, không nên tự suy diễn. Giữ nguyên.

---

## 📊 Đánh giá

| | Trước | Sau |
|---|---|---|
| Query DB / 5 phút | 0 (nhưng có thể lệch) | ~3/channel hoạt động |
| Thời gian sửa lệch | **Không bao giờ** | ≤5 phút |
| Query DB trên đường nóng | 0 | 0 (không đổi) |
| Redis mất dữ liệu | Badge mất vĩnh viễn | Badge tự phục hồi ≤5 phút |

### Ví dụ: Redis bị FLUSHDB

```
t0:  Redis bị flush → tất cả unread hash mất
t1:  User B mở app → REST /channels/unread
     → Redis miss → fallback DB (getUnreadCountForUser) → count ĐÚNG ✓
     → set lại Redis
t2:  Đến lần reconcile kế tiếp → set lại toàn bộ channel hot → chuẩn ✓
```

→ Nhờ fallback ở Phase 4, Redis mất dữ liệu **không gây sai số**, chỉ gây chậm 1 lần.

---

## ⚠️ Chi phí của reconcile

```
Reconcile mỗi 5 phút, mỗi channel hot:
  1 query channelMember.findMany
  1 query channelReadState.findMany
  1–3 query message.count
  1 pipeline HSET
  ────────────────────────────────
  ~4 query DB / channel / 5 phút
```

**Ví dụ 50 channel hot:** 200 query DB / 5 phút = **0.67 query/s**. Rất nhẹ.

**Nếu 500 channel hot:** 2000 query / 5 phút = 6.7 query/s. Vẫn OK.

**Nếu 5000 channel hot:** 20.000 query / 5 phút = 67 query/s → cân nhắc tăng interval lên 15 phút.

---

## 🐛 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|---|---|---|
| Reconcile không chạy | `scheduleReconcileJob` chưa gọi | Gọi trong `start()` |
| Chạy trùng N lần (N instance) | Dùng `setInterval` thay vì BullMQ repeat | Dùng BullMQ repeat (đã làm) |
| `MemberStatus` chưa import | Thiếu import | `import { MemberStatus } from '~/constants/enum'` |
| `channelId` NaN trong BigInt | String không parse được | Guard `Number.isInteger` |
| Reconcile sửa sai (count = 0 hết) | `channel_read_states` stale | Kiểm tra `upsertChannelReadState` đã gọi ở leave_channel |
| `ZADD` làm ZSET phình to | Không dọn channel cũ | `cleanupActiveChannels()` (đã có) |

---

## ✅ Checkpoint Phase 5

- [ ] `markChannelActive` + `getActiveChannelIds` + `cleanupActiveChannels` trong `unread.services.ts`
- [ ] `computeUnreadCountsFromDb` + `reconcileChannel` trong `unread.services.ts`
- [ ] File `src/queues/reconcile.worker.ts` đã tạo
- [ ] `unreadReconcileQueue` trong `queue.ts`
- [ ] `startReconcileWorker` + `scheduleReconcileJob` gọi trong `index.ts`
- [ ] `shutdown()` đóng `reconcileWorker`
- [ ] Test: sửa tay Redis (FLUSHDB / HSET sai) → chờ 5 phút → count về đúng

### Test

```bash
# Gây lệch thủ công
docker exec -it chat-redis redis-cli DEL chat:unread:10
docker exec -it chat-redis redis-cli HSET chat:unread:10 15 999

# Đợi ≤5 phút, kiểm tra lại
docker exec -it chat-redis redis-cli HGETALL chat:unread:10
# → 15 phải = count đúng tính từ DB
```

---

## 🔜 Phase tiếp theo

**[Phase 6: Testing & Rollout →](./phase-06-testing-rollout.md)**

Phase 6 gom toàn bộ test matrix + checklist nghiệm thu để đưa lên production.
