import { MessageType } from '~/constants/enum'
import databaseServices from '~/services/database.services'
import { getChannelMemberIds, redis } from '~/services/redis.services'

// ============ KEYS ============
const unreadKey = (channelId: string | number) => `unread:${channelId}`
const UNREAD_TTL = 60 * 60 * 24 * 7 // 7 ngày

// ZSET tracking các channel "đang hoạt động" (có message gần đây).
// Reconcile job dùng ZSET này để biết cần kiểm tra channel nào,
// thay vì quét toàn bộ channel (có thể hàng nghìn).
const activeKey = 'unread:active'

// Channel không hoạt động quá 1 ngày → dọn khỏi ZSET.
const ACTIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 1 ngày

/**
 * Cấu trúc key (Redis Hash):
 *
 *   Key:    chat:unread:10      (unread:10 sau khi ioredis tự thêm prefix "chat:")
 *   Type:   Hash
 *   Field:  userId
 *   Value:  số tin chưa đọc
 *
 *   HGETALL chat:unread:10 → { "15": "3", "20": "0", "30": "7" }
 *
 * Vì sao Hash chứ không phải String/Set:
 *   - HINCRBY atomic O(1)  → tăng counter không race dù nhiều instance
 *   - HMGET 1 round trip cho N field → đọc count của 50 member chỉ 1 RTT
 *   - HSET reset 1 field    → chỉ ghi đè user vừa đọc, không đụng user khác
 */

/**
 * Tăng unread count cho nhiều user trong 1 channel (1 round trip).
 *
 * Dùng trong write path: sau khi tạo message, tăng cho tất cả member
 * (trừ người gửi).
 */
export const incrementUnreadBatch = async (
  channelId: string | number,
  userIds: number[],
  amount = 1
): Promise<void> => {
  if (userIds.length === 0) return

  const key = unreadKey(channelId)
  const pipeline = redis.pipeline()

  for (const userId of userIds) {
    pipeline.hincrby(key, String(userId), amount)
  }
  pipeline.expire(key, UNREAD_TTL)

  await pipeline.exec()
}

/**
 * Reset unread count của 1 user về 0 (khi user đọc channel).
 */
export const resetUnread = async (channelId: string | number, userId: number): Promise<void> => {
  const key = unreadKey(channelId)

  const pipeline = redis.pipeline()
  pipeline.hset(key, String(userId), 0)
  pipeline.expire(key, UNREAD_TTL)

  await pipeline.exec()
}

/**
 * Ghi đè count của 1 user trong 1 channel (dùng khi đối chiếu với DB).
 */
export const setUnreadCount = async (channelId: string | number, userId: number, count: number): Promise<void> => {
  const key = unreadKey(channelId)

  const pipeline = redis.pipeline()
  pipeline.hset(key, String(userId), count)
  pipeline.expire(key, UNREAD_TTL)

  await pipeline.exec()
}

/**
 * Đọc count của nhiều user trong 1 channel (1 round trip). (Socket)
 */
export const getUnreadCounts = async (channelId: string | number, userIds: number[]): Promise<Map<number, number>> => {
  const result = new Map<number, number>()
  if (userIds.length === 0) return result

  const values = await redis.hmget(unreadKey(channelId), ...userIds.map(String))

  userIds.forEach((userId, index) => {
    const raw = values[index]
    result.set(userId, raw === null ? 0 : Number(raw))
  })

  return result
}

/**
 * Lấy unread count của 1 user trong 1 channel. (API)
 *
 * Nguồn sự thật = Redis Hash. Nếu Redis miss (key hết TTL, Redis restart...)
 * → fallback tính từ DB rồi set lại Redis (best-effort).
s */
export const getUnreadCountForUser = async (
  channelId: string | number,
  userId: number,
  lastReadMessageId: bigint | null
): Promise<number> => {
  const key = unreadKey(channelId)

  // 1. Thử Redis
  const cached = await redis.hget(key, String(userId))
  if (cached !== null) {
    return Number(cached)
  }

  // 2. Redis miss → fallback tính từ DB
  const count = await databaseServices.prisma.message.count({
    where: {
      channelId: BigInt(channelId),
      id: { gt: lastReadMessageId ?? BigInt(0) },
      messageType: { not: MessageType.CONFIG }
    }
  })

  // 3. Set lại Redis (best-effort, không throw — lỗi Redis không được làm fail REST)
  await redis
    .pipeline()
    .hset(key, String(userId), count)
    .expire(key, UNREAD_TTL)
    .exec()
    .catch(() => {})

  return count
}

// ============ INVALIDATE ============
/**
 * Xoá toàn bộ counter của channel (VD: channel bị xoá).
 */
export const invalidateUnread = async (channelId: string | number): Promise<void> => {
  await redis.del(unreadKey(channelId))
}

/**
 * Tính count chính xác từ DB (nguồn sự thật gốc).
 */
export const computeUnreadCountsFromDb = async (channelId: number, userIds: number[]): Promise<Map<number, number>> => {
  const result = new Map<number, number>()
  if (userIds.length === 0) return result

  const bigChannelId = BigInt(channelId)

  // 1. Lấy read state của tất cả user (1 query)
  const readStates = await databaseServices.prisma.channelReadState.findMany({
    where: {
      channelId: bigChannelId,
      userId: { in: userIds.map((id) => BigInt(id)) }
    },
    select: {
      userId: true,
      lastReadMessageId: true
    }
  })

  // 2. Map userId → cutoff (user chưa có read state → cutoff = 0 → count = toàn bộ message)
  const cutoffMap = new Map<number, bigint>()
  for (const state of readStates) {
    cutoffMap.set(Number(state.userId), state.lastReadMessageId ?? BigInt(0))
  }

  // User KHÔNG có read state (chưa vào channel lần nào) → cutoff = 0.
  // Phải thêm vào cutoffMap TRƯỚC khi gom distinct cutoff, nếu không:
  //   - '0' không có trong `cutoffs` → không có count query cho cutoff 0
  //   → countByCutoff.get('0') = undefined → count = 0 (SAI, phải là toàn bộ message)
  for (const userId of userIds) {
    if (!cutoffMap.has(userId)) {
      cutoffMap.set(userId, BigInt(0))
    }
  }

  // 3. Gom distinct cutoff.
  // Dùng string vì BigInt so sánh bằng === theo tham chiếu, không theo giá trị
  // → Set<string> mới gom trùng đúng cách.
  const cutoffs = new Set<string>()
  for (const cutoff of cutoffMap.values()) {
    cutoffs.add(cutoff.toString())
  }

  // 4. 1 count query cho mỗi distinct cutoff (thường chỉ 1–3)
  const countByCutoff = new Map<string, number>()
  await Promise.all(
    [...cutoffs].map(async (cutoffStr) => {
      const count = await databaseServices.prisma.message.count({
        where: {
          channelId: bigChannelId,
          id: { gt: BigInt(cutoffStr) },
          messageType: { not: MessageType.CONFIG }
        }
      })
      countByCutoff.set(cutoffStr, count)
    })
  )

  // 5. Trả về map userId → count
  for (const userId of userIds) {
    const cutoff = cutoffMap.get(userId) ?? BigInt(0)
    result.set(userId, countByCutoff.get(cutoff.toString()) ?? 0)
  }

  return result
}

/**
 * Đối chiếu count của 1 channel giữa DB và Redis, ghi đè Redis.
 *
 * DB là nguồn chân lý → count tính từ DB là giá trị đúng.
 * Redis chỉ là cache nên ghi đè được an toàn.
 */
export const reconcileChannel = async (channelId: string): Promise<number> => {
  // 1. Lấy member ACTIVE của channel
  const userIds = await getChannelMemberIds(channelId)

  if (userIds.length === 0) return 0

  // 2. Tính count chuẩn từ DB
  const dbCounts = await computeUnreadCountsFromDb(Number(channelId), userIds)

  // 3. Đọc count hiện tại trong Redis.
  const key = unreadKey(channelId)
  const rawValues = await redis.hmget(key, ...userIds.map(String))

  // 4. Tìm user lệch → ghi đè
  const pipeline = redis.pipeline()
  let fixed = 0

  for (let i = 0; i < userIds.length; i++) {
    const userId = userIds[i]
    const dbCount = dbCounts.get(userId) ?? 0
    const raw = rawValues[i]

    // Field chưa tồn tại → luôn cần tạo (kể cả khi dbCount = 0),
    // để REST không phải query DB lần sau.
    if (raw === null) {
      pipeline.hset(key, String(userId), dbCount)
      fixed++
      continue
    }

    if (dbCount !== Number(raw)) {
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

/**
 * Đánh dấu channel là "đang hoạt động" (có message mới).
 *
 * Ghi vào ZSET `unread:active`: member = channelId, score = timestamp (ms).
 * Reconcile job dùng ZSET này để biết cần kiểm tra channel nào —
 * không phải quét toàn bộ channel.
 */
export const markChannelActive = async (channelId: string | number): Promise<void> => {
  await redis.zadd(activeKey, Date.now(), String(channelId))
}

/**
 * Lấy danh sách channel hoạt động từ `sinceMs` trở đi.
 */
export const getActiveChannelIds = async (sinceMs: number): Promise<string[]> => {
  return redis.zrangebyscore(activeKey, sinceMs, '+inf')
}

/**
 * Dọn channel quá lâu không hoạt động khỏi ZSET (tránh phình to vô hạn).
 */
export const cleanupActiveChannels = async (): Promise<number> => {
  const cutoff = Date.now() - ACTIVE_MAX_AGE_MS
  return redis.zremrangebyscore(activeKey, '-inf', cutoff)
}
