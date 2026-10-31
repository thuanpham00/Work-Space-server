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
    attempts: 3, // Retry tối đa 3 lần với exponential backoff
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 1000 }, // Dọn job đã xong (giữ 1000 job gần nhất, xoá cũ hơn)
    removeOnFail: { count: 5000 } // Giữ job fail tối đa 5000 (cho debug)
  }
})

// Log khi queue có lỗi
unreadQueue.on('error', (err) => {
  console.error('[unreadQueue] error:', err)
})

// ============ RECONCILE QUEUE (Phase 5) ============
// Queue để reconcile counter Redis với DB (tự sửa lệch).
// Dùng BullMQ repeat job → chỉ 1 instance chạy mỗi lần.
export const unreadReconcileQueue = new Queue('unread-reconcile', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 }
  }
})

unreadReconcileQueue.on('error', (err) => {
  console.error('[unreadReconcileQueue] error:', err)
})
