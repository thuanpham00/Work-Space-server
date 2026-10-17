import { createAdapter } from '@socket.io/redis-adapter'
import { createClient } from 'redis'
import type { Server } from 'socket.io'

/**
 * Publish/Subscribe là mô hình truyền tin 1-nhiều (fan-out) trong Redis:
  Publisher (Instance A) → gửi message lên 1 channel trong Redis.
  Subscriber (Instance B, C, D…) → đăng ký nhận message từ channel đó.
  Khi publisher gửi → Redis tự động fan-out tới tất cả subscriber cùng lúc.
 */

// Redis yêu cầu: 1 connection publish, 1 connection subscribe
const pubClient = createClient({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379'
})
const subClient = pubClient.duplicate()

// Cache adapter init promise để không init 2 lần
let adapterReady: Promise<void> | null = null

/**
 * Gắn Redis adapter vào Socket.IO server.
 * Gọi 1 lần khi khởi động.
 *
 * Hàm này await cho tới khi:
 * 1. Cả 2 client Redis connected
 * 2. Adapter đã gắn vào io server
 */
export const initRedisAdapter = async (io: Server): Promise<void> => {
  if (adapterReady) return adapterReady

  adapterReady = (async () => {
    try {
      await Promise.all([pubClient.connect(), subClient.connect()])
      io.adapter(createAdapter(pubClient, subClient))
      console.log('[RedisAdapter] attached')
    } catch (err) {
      console.error('[RedisAdapter] init error:', err)
      throw err
    }
  })()

  return adapterReady
}
