import { createAdapter } from '@socket.io/redis-adapter'
import { createClient } from 'redis'
import type { Server } from 'socket.io'
import { envConfig } from '~/utils/config'

/**
 * Publish/Subscribe là mô hình truyền tin 1-nhiều (fan-out) trong Redis:
  Publisher (Instance A) → gửi message lên 1 channel trong Redis.
  Subscriber (Instance B, C, D…) → đăng ký nhận message từ channel đó.
  Khi publisher gửi → Redis tự động fan-out tới tất cả subscriber cùng lúc.

 * Toàn bộ logic PUBLISH/PSUBSCRIBE nằm trong thư viện @socket.io/redis-adapter:
 * - constructor của RedisAdapter gọi subClient.pSubscribe(channel + "*")
 * - method broadcast() gọi pubClient.publish(channel, msg)
 *
 * File này chỉ làm nhiệm vụ WIRING: tạo 2 connection + gắn adapter vào io.
 */

// Redis yêu cầu: 1 connection publish, 1 connection subscribe
const pubClient = createClient({
  url: envConfig.redis_url
})
const subClient = pubClient.duplicate()

// ============ ERROR HANDLING ============
// BẮT BUỘC: node-redis emit 'error' khi có lỗi mạng.
// Nếu không có listener → Node throw "Unhandled error event" → process chết ngay.
// Đây là guard sống còn của cả server.
pubClient.on('error', (err) => {
  console.error('[RedisAdapter] pubClient error:', err.message)
})

subClient.on('error', (err) => {
  console.error('[RedisAdapter] subClient error:', err.message)
})

pubClient.on('reconnecting', () => {
  console.warn('[RedisAdapter] pubClient reconnecting...')
})

subClient.on('reconnecting', () => {
  console.warn('[RedisAdapter] subClient reconnecting...')
})

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
      // isOpen guard: connect() lần 2 sẽ throw "Socket already opened"
      if (!pubClient.isOpen) await pubClient.connect()
      if (!subClient.isOpen) await subClient.connect()

      io.adapter(createAdapter(pubClient, subClient))
      console.log('[RedisAdapter] attached')
    } catch (err) {
      console.error('[RedisAdapter] init error:', err)
      // Reset để có thể thử lại (ví dụ: boot lại trong test)
      adapterReady = null
      throw err
    }
  })()

  return adapterReady
}

/**
 * Đóng cả 2 connection khi server shutdown.
 * Gọi trong SIGTERM/SIGINT handler.
 */
export const closeRedisAdapter = async (): Promise<void> => {
  try {
    if (pubClient.isOpen) await pubClient.quit()
    if (subClient.isOpen) await subClient.quit()
    console.log('[RedisAdapter] closed')
  } catch (err) {
    console.error('[RedisAdapter] close error:', err)
  }
}
