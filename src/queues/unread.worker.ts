import { Worker, Job } from 'bullmq'
import IORedis from 'ioredis'
import { envConfig } from '~/utils/config'

// ============ TYPES ============
export interface UnreadEvent {
  channelId: number
  workspaceId: number
  senderId: number
  messageId: number
  createdAt: string
}

export interface UnreadBatchJob {
  events: UnreadEvent[]
}

// ============ WORKER ============
const startUnreadWorker = () => {
  // Tạo connection riêng cho worker
  const connection = new IORedis(envConfig.redis_url, { maxRetriesPerRequest: null })

  // Tạo Worker
  const worker = new Worker<UnreadBatchJob>(
    'unread-batch', // tên queue (phải khớp với queue.ts)

    // Processor function: xử lý job
    async (job: Job<UnreadBatchJob>) => {
      const { events } = job.data

      if (events.length === 0) {
        return { processed: 0 }
      }

      console.log(`[Unread Worker] processing ${events.length} events`)

      // ============ BẮT ĐẦU XỬ LÝ ============
      // (Phase 7 sẽ thay bằng logic thật - broadcast pub/sub)
      // Tạm thời chỉ log

      for (const event of events) {
        console.log(`  - channel ${event.channelId} message ${event.messageId}`)
      }

      return { processed: events.length }
    },

    // Worker options
    {
      connection,

      // Số job chạy song song
      concurrency: 5,

      // Rate limit: tối đa 10 job mỗi 1 giây
      limiter: {
        max: 10,
        duration: 1000
      }
    }
  )

  // ============ EVENT LOGS ============
  worker.on('completed', (job) => {
    console.log(`[Unread Worker] job ${job.id} completed`)
  })

  worker.on('failed', (job, err) => {
    console.error(`[Unread Worker] job ${job?.id} failed:`, err.message)
  })

  worker.on('error', (err) => {
    console.error(`[Unread Worker] worker error:`, err)
  })

  return worker
}

export default startUnreadWorker
