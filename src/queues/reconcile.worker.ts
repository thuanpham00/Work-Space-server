import { Worker } from 'bullmq'
import IORedis from 'ioredis'
import { cleanupActiveChannels, getActiveChannelIds, reconcileChannel } from '~/services/unread.services'
import { envConfig } from '~/utils/config'
import { unreadReconcileQueue } from './queue'

// Reconcile chạy mỗi 5 phút.
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000

// Lấy channel hoạt động trong 10 phút gần nhất.
// Gấp đôi interval để không sót channel vừa ngừng hoạt động
// (nằm giữa 2 lần reconcile).
const ACTIVE_LOOKBACK_MS = 10 * 60 * 1000

export const RECONCILE_JOB_NAME = 'reconcile-unread'

// kiểm tra channel hoạt động trong 10 phút gần nhất. sau đó kiểm tra có lệch count trong redis (truth src so với db không)
// xử lý đồng bộ
export const startReconcileWorker = () => {
  const connection = new IORedis(envConfig.redis_url, { maxRetriesPerRequest: null })

  const worker = new Worker(
    'unread-reconcile',
    async () => {
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
          // 1 channel lỗi không được làm hỏng cả vòng reconcile.
          console.error(`[Reconcile] channel ${channelId} failed:`, err)
        }
      }

      // Dọn channel quá 1 ngày không hoạt động khỏi ZSET
      await cleanupActiveChannels()

      console.log(`[Reconcile] done: ${channelIds.length} channels, ${fixed} user(s) fixed`)
      return { channels: channelIds.length, fixed }
    },
    {
      connection,
      // Chạy tuần tự để không dồn query DB
      concurrency: 1,
      // Tối đa 1 lần/phút
      limiter: { max: 1, duration: 60_000 }
    }
  )

  worker.on('failed', (job, err) => {
    console.error(`[Reconcile] job ${job?.id} failed:`, err.message)
  })

  worker.on('error', (err) => {
    console.error(`[Reconcile] worker error:`, err)
  })

  return worker
}

/**
 * Đăng ký repeat job (gọi 1 lần khi boot).
 *
 * BullMQ đảm bảo chỉ 1 instance chạy mỗi lần → không cần lock thủ công.
 *
 * Lưu ý: BullMQ v6 đã bỏ option `repeat` trong `Queue.add`.
 * Phải dùng `upsertJobScheduler` (Job Scheduler mới).
 */
export const scheduleReconcileJob = async () => {
  await unreadReconcileQueue.upsertJobScheduler(
    RECONCILE_JOB_NAME,
    { every: RECONCILE_INTERVAL_MS },
    {
      name: RECONCILE_JOB_NAME,
      data: {},
      opts: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 100
      }
    }
  )
}
