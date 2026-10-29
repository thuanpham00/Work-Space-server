import { Worker, Job, DelayedError } from 'bullmq'
import IORedis from 'ioredis'
import { getChannelMemberIds } from '~/services/redis.services'
import { waitForIO } from '~/socket/socket-instance'
import { Socket_Room } from '~/socket/utils'
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
  // Số lần job đã bị defer vì io chưa sẵn sàng.
  // Tự quản lý vì path moveToDelayed + DelayedError KHÔNG tăng attemptsMade của BullMQ.
  ioRetries?: number
}

interface ChannelGroup {
  workspaceId: number
  latestMessageId: number
  senders: Set<number>
}

// ============ WORKER ============

// Thời gian chờ trước khi thử lại job (ms).
// 5s: đủ để server boot xong (adapter attach + connection handler đăng ký).
const RETRY_DELAY_MS = 5_000

// Số lần tối đa được defer khi io chưa sẵn sàng.
// Lý do cần giới hạn: path moveToDelayed + DelayedError KHÔNG tăng attemptsMade
// (đã verify bằng probe) → nếu không giới hạn sẽ retry vô hạn.
// Sau khi hết lượt → để BullMQ đánh dấu failed (có log, không mất im lặng).
const MAX_IO_RETRIES = 10

export const startUnreadWorker = () => {
  // Tạo connection riêng cho worker
  const connection = new IORedis(envConfig.redis_url, { maxRetriesPerRequest: null })

  // Tạo Worker
  const worker = new Worker<UnreadBatchJob>(
    'unread-batch', // tên queue (phải khớp với queue.ts)

    // 1 job có nhiều event đã được gom lại thành 1 job
    async (job: Job<UnreadBatchJob>, token?: string) => {
      const { events } = job.data

      if (events.length === 0) {
        return { processed: 0 }
      }

      // ============ BẮT ĐẦU XỬ LÝ ============
      // Bước 1: Gom events theo channelId
      //   - 1 channel → 1 emit (thay vì 1 emit/event)
      //   - latestMessageId = max(messageId) để client biết tin mới nhất
      //   - senders = tập người gửi để loại khỏi recipients
      const groups = new Map<number, ChannelGroup>()
      for (const event of events) {
        const current = groups.get(event.channelId)
        if (current) {
          current.latestMessageId = Math.max(current.latestMessageId, event.messageId)
          current.senders.add(event.senderId)
        } else {
          groups.set(event.channelId, {
            workspaceId: event.workspaceId,
            latestMessageId: event.messageId,
            senders: new Set([event.senderId])
          })
        }
      }

      // Bước 2: Lấy io instance.
      // Nếu server chưa sẵn sàng (đang boot, adapter chưa attach) → KHÔNG được nuốt event.
      // Trước đây code `return { processed: ... }` khiến BullMQ coi là thành công
      // → event bị mất vĩnh viễn, user không bao giờ thấy badge unread.
      //
      // Cách defer đúng (đã verify bằng probe script):
      //   1. job.moveToDelayed(timestamp, token) → đưa job về hàng đợi delayed
      //   2. throw new DelayedError(...)         → worker KHÔNG gọi moveToFailed
      // Nếu chỉ throw DelayedError mà không moveToDelayed → job mắc kẹt ở 'active'
      // (BullMQ không tự retry), dẫn tới "Missing lock for job" và event vẫn mất.
      let io
      try {
        io = await waitForIO(30_000)
      } catch (err) {
        const message = (err as Error).message
        const ioRetries = job.data.ioRetries ?? 0

        // Hết lượt retry → ném Error thường để BullMQ đánh dấu 'failed'
        // (có log + theo dõi được, thay vì retry vô hạn im lặng)
        if (ioRetries >= MAX_IO_RETRIES) {
          console.error(`[Unread Worker] io vẫn chưa sẵn sàng sau ${ioRetries} lần retry → đánh dấu failed:`, message)
          throw new Error(`IO chưa sẵn sàng sau ${ioRetries} lần retry: ${message}`, { cause: err })
        }

        console.warn(
          `[Unread Worker] io chưa sẵn sàng (lần ${ioRetries + 1}/${MAX_IO_RETRIES}), dời job để thử lại:`,
          message
        )

        // Lưu counter (được persist qua updateData) để không retry vô hạn
        await job.updateData({ ...job.data, ioRetries: ioRetries + 1 })

        // Đưa job về delayed trước khi throw để không mất event
        await job.moveToDelayed(Date.now() + RETRY_DELAY_MS, token)
        throw new DelayedError(`IO chưa sẵn sàng: ${message}`)
      }

      let recipientCount = 0
      let channelCount = 0

      for (const [channelId, group] of groups) {
        const members = await getChannelMemberIds(channelId.toString())
        const recipients = members.filter((user) => !group.senders.has(user))
        if (recipients.length === 0) continue

        const rooms = recipients.map((user) => Socket_Room.user(String(user)))

        io.to(rooms).emit('channel_unread', {
          channelId,
          workspaceId: group.workspaceId,
          latestMessageId: group.latestMessageId
        })

        recipientCount += recipients.length
        channelCount++
      }

      return { processed: events.length, channels: channelCount, recipients: recipientCount }
    },
    // Worker options
    {
      connection,
      concurrency: 5, // Số job chạy song song
      limiter: {
        max: 10,
        duration: 1000 // Rate limit: tối đa 10 job mỗi 1 giây
      }
    }
  )

  // ============ EVENT LOGS ============
  worker.on('failed', (job, err) => {
    console.error(`[Unread Worker] job ${job?.id} failed:`, err.message)
  })

  worker.on('error', (err) => {
    console.error(`[Unread Worker] worker error:`, err)
  })

  return worker
}

// chạy mỗi khi có job từ queue vào thì worker sẽ lấy job ra thực thi
