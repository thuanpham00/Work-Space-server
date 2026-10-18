import { redis } from '~/services/redis.services'

const PRESENCE_TTL = 60 // 60 giây - nếu không heartbeat thì coi offline

// Cứ 30s client emit('heartbeat') → server nhận được → gọi ZADD với timestamp mới + EXPIRE reset về 120s → giữ user được coi là online trong Redis.
// nếu client ko gửi heartbeat nữa là user offline là sẽ bị xóa khỏi redis sau 120s

/**
 * Đánh dấu user online (gọi khi connect + mỗi heartbeat).
 *
 * - ZADD với score = timestamp
 * - EXPIRE để tự xoá key nếu user offline thật (không phải idle)
 */
/**
 * 
 * Key   :  chat:presence:user:15          │  ← tên định danh (duy nhất)
│  Type  :  zset (Sorted Set)              │  ← kiểu dữ liệu (cố định)
│  Value :  {                              │
│             "socket_abc": 1700000000,    │  ← member + score
│             "socket_def": 1700000030     │
│           }                              │
│  TTL   :  120 giây   
 */
export const setUserOnline = async (userId: number, socketId: string): Promise<void> => {
  const key = `presence:user:${userId}`
  await redis.zadd(key, Date.now(), socketId)
  // Set TTL cho key = 2x PRESENCE_TTL (cleanup nếu user offline hoàn toàn)
  await redis.expire(key, PRESENCE_TTL * 2)
}

/**
 * Đánh dấu 1 socket offline (gọi khi disconnect).
 *
 * - ZREM socketId
 * - Nếu set rỗng → DEL key (tiết kiệm memory)
 */
export const setUserOffline = async (userId: number, socketId: string): Promise<void> => {
  const key = `presence:user:${userId}`
  await redis.zrem(key, socketId)

  // Cleanup key nếu rỗng
  const count = await redis.zcard(key)
  if (count === 0) {
    await redis.del(key)
  }
}

/**
 * Kiểm tra user có online không (còn socket nào active không).
 */
export const isUserOnline = async (userId: number): Promise<boolean> => {
  const count = await redis.zcard(`presence:user:${userId}`)
  return count > 0
}

/**
 * Cleanup idle sockets (không heartbeat trong X giây).
 * Gọi từ cron job mỗi 60s.
 */

// Mỗi tab có 1 socket riêng, mỗi socket có 1 score riêng. Tab nào gửi heartbeat thì score được refresh. Tab nào ngưng heartbeat thì score đứng yên → bị worker cắt khi đến cutoff.
export const cleanupIdlePresence = async (): Promise<void> => {
  const stream = redis.scanStream({
    match: `${redis.options.keyPrefix ?? 'chat:'}presence:user:*`
  })

  const cutoff = Date.now() - PRESENCE_TTL * 1000
  let cleaned = 0

  for await (const keys of stream) {
    for (const fullKey of keys) {
      // Bỏ prefix vì redis tự thêm
      const key = fullKey.replace(redis.options.keyPrefix ?? 'chat:', '')

      // Xoá members có score cũ
      const removed = await redis.zremrangebyscore(key, '-inf', cutoff)
      cleaned += removed

      // Nếu set rỗng → xoá key
      const count = await redis.zcard(key)
      if (count === 0) {
        await redis.del(key)
      }
    }
  }

  if (cleaned > 0) {
    console.log(`[Presence] cleaned ${cleaned} idle sockets`)
  }
}

// Heartbeat = tín hiệu "tôi còn sống". Score trong Redis = bằng chứng cho tín hiệu đó. Không heartbeat = không bằng chứng = bị loại.

// Tab nào emit heartbeat → score được refresh
// Tab nào không emit → score đứng yên, sau 60s bị ZREMRANGEBYSCORE xóa
// Cả key bị xóa sau 120s nếu tất cả socket đều không heartbeat
