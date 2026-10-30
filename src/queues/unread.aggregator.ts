import { unreadQueue } from './queue'
import { UnreadEvent } from './unread.types'
import IORedis from 'ioredis'
import { envConfig, REDIS_KEY_PREFIX } from '~/utils/config'

const FLUSH_INTERVAL = 1000 // Flush mỗi 1 giây
const BUFFER_MAX_SIZE = 10000 // Chống tràn nếu worker chết

// ============ CONNECTION ============
// Connection riêng (không dùng singleton ioredis để tránh conflict)
// keyPrefix: 'chat:' → key logic "unread:buffer" được lưu thật là "chat:unread:buffer"
const connection = new IORedis(envConfig.redis_url, {
  maxRetriesPerRequest: null,
  keyPrefix: REDIS_KEY_PREFIX
})

/**
 * Vì connection đã có keyPrefix: 'chat:', key thật trong Redis = chat:unread:buffer
 */
const BUFFER_KEY = 'unread:buffer'

// ============ LUA: FLUSH ATOMIC ============
/**
 * Đọc TOÀN BỘ buffer + XOÁ trong 1 lệnh Lua duy nhất.
 *
 * VÌ SAO CẦN:
 * Nếu dùng `LRANGE` rồi `DEL` bằng 2 lệnh riêng thì có race condition:
 *   t=1.000s  LRANGE → lấy được 100 event
 *   t=1.001s  Producer LPUSH event #101   ← event mới vào buffer
 *   t=1.002s  DEL buffer                 ← XOÁ LUÔN event #101 ❌ MẤT EVENT
 *
 * Lua script chạy atomic (Redis không interrupt được script giữa chừng):
 *   LRANGE + DEL là 1 đơn vị nguyên tử → không có producer nào chen được vào giữa.
 *
 * Lưu ý: KEYS[1] trong Lua đã bao gồm prefix do ioredis tự thêm vào.
 */
connection.defineCommand('flushUnreadBuffer', {
  numberOfKeys: 1,
  lua: `
    local events = redis.call('LRANGE', KEYS[1], 0, -1)
    if #events > 0 then
      redis.call('DEL', KEYS[1])
    end
    return events
  `
})

// ============ PRODUCER ============

/**
 * Đẩy 1 event vào buffer. Gọi ngay trong main flow.
 * Hàm này cực nhanh (~1ms), không block.
 */
export const enqueueUnread = async (event: UnreadEvent): Promise<void> => {
  // LPUSH thêm vào đầu list
  await connection.lpush(BUFFER_KEY, JSON.stringify(event))

  // LTRIM giữ tối đa BUFFER_MAX_SIZE phần tử (chống tràn)
  await connection.ltrim(BUFFER_KEY, 0, BUFFER_MAX_SIZE - 1)
}

// ============ CONSUMER (FLUSH SCHEDULER) ============

/**
 * Flag chống chạy chồng: nếu 1 vòng flush mất > FLUSH_INTERVAL thì vòng sau
 * phải bỏ qua, không được chạy song song với vòng đang dở.
 */
let isFlushing = false

/**
 * Scheduler: cứ 1 giây, flush buffer thành 1 job.
 * Gọi 1 lần khi khởi động server.
 */
export const startUnreadAggregator = () => {
  setInterval(async () => {
    // Chống chạy chồng (flush lâu hơn interval)
    if (isFlushing) {
      console.warn('[Aggregator] previous flush still running, skip this tick')
      return
    }
    isFlushing = true

    try {
      // 1. Lấy toàn bộ events + xoá buffer ATOMIC (Lua script)
      const rawEvents = (await connection.flushUnreadBuffer(BUFFER_KEY)) as string[]

      if (rawEvents.length === 0) return

      // 2. Parse JSON, loại bỏ event lỗi
      const parsed = rawEvents
        .map((e) => {
          try {
            return JSON.parse(e) as UnreadEvent
          } catch {
            return null
          }
        })
        .filter((e): e is UnreadEvent => e !== null)

      if (parsed.length === 0) return

      // 3. Push 1 job gồm N events vào BullMQ
      // Nếu add() fail (Redis down) → ĐẨY LẠI events về buffer để không mất event
      try {
        await unreadQueue.add('batch', { events: parsed })
      } catch (err) {
        console.error('[Aggregator] queue.add failed, requeue events to buffer:', err)

        // Đẩy lại vào buffer (RPUSH để giữ đúng thứ tự cũ)
        // Dùng pipeline để 1 round-trip
        const pipeline = connection.pipeline()
        for (const event of parsed) {
          pipeline.rpush(BUFFER_KEY, JSON.stringify(event))
        }
        await pipeline.ltrim(BUFFER_KEY, 0, BUFFER_MAX_SIZE - 1)
        await pipeline.exec()

        throw err // để log ở catch bên ngoài
      }

      console.log(`[Aggregator] flushed ${parsed.length} events to 1 job`)
    } catch (err) {
      console.error('[Aggregator] error:', err)
    } finally {
      isFlushing = false
    }
  }, FLUSH_INTERVAL)

  console.log(`[Aggregator] started, flush every ${FLUSH_INTERVAL}ms`)
}

// chạy mỗi giây 1 lần (gom event thành job)

/**
 * ở đây enqueueUnread sẽ thực hiện ở nơi handleMessage để lấy event và push event (producer) này vào 1 cái list redis (buffer) và gom N event gom lại thành 1 job sau đó push job này vào hàng đợi (queue BullMQ). và tiếp theo ở @src/queues/unread.worker.ts worker lấy job từ queue ra thực thi
 */

/**
 *Dùng lua script nhanh hơn tránh producer mới chen giữa mất event.
 Còn cờ isFlushing chỉ đánh dấu vòng đó chưa xong và bỏ qua tránh chạy chồng 
 */
