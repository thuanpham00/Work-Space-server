import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { envConfig } from '~/utils/config'

// ============ CONNECTION ============
// BullMQ cần 1 connection riêng (không dùng ioredis singleton vì cần config đặc biệt)
const connection = new IORedis(envConfig.redis_url, {
  // Lý do: BullMQ tự quản lý retry, không để ioredis tự retry
  maxRetriesPerRequest: null
})

// ============ QUEUE DEFINITION ============
export const unreadQueue = new Queue('unread-batch', {
  connection,
  defaultJobOptions: {
    // Retry tối đa 3 lần với exponential backoff
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },

    // Dọn job đã xong (giữ 1000 job gần nhất, xoá cũ hơn)
    removeOnComplete: { count: 1000 },

    // Giữ job fail tối đa 5000 (cho debug)
    removeOnFail: { count: 5000 }
  }
})

// Log khi queue có lỗi
unreadQueue.on('error', (err) => {
  console.error('[unreadQueue] error:', err)
})
