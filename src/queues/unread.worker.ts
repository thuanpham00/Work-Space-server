import { Worker, Job, DelayedError } from 'bullmq'
import IORedis from 'ioredis'
import { ChannelType } from '~/constants/enum'
import { ChannelUnreadPayload, UnreadBatchJob } from '~/queues/unread.types'
import { getChannelMemberIds } from '~/services/redis.services'
import { getUnreadCounts } from '~/services/unread.services'
import { waitForIO } from '~/socket/socket-instance'
import { Socket_Room } from '~/socket/utils'
import { envConfig } from '~/utils/config'

interface ChannelGroup {
  workspaceId: number | null
  type: ChannelType
  /** Id của message MỚI NHẤT trong batch */
  latestMessageId: number
  /** Sender của message MỚI NHẤT (đi cùng latestMessageId, luôn trỏ cùng 1 message) */
  latestSenderId: number
  /** TẤT CẢ người gửi trong batch → dùng để lọc khỏi recipients */
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
      //   - 1 channel → 1 group
      //   - latestMessageId = max(messageId) để client biết tin mới nhất
      //   - latestSenderId = sender CỦA message mới nhất (cập nhật đồng bộ với latestMessageId)
      //   - senders = tập người gửi để loại khỏi recipients
      const groups = new Map<number, ChannelGroup>()
      for (const event of events) {
        const current = groups.get(event.channelId)
        if (current) {
          // latestMessageId và latestSenderId phải cập nhật ĐỒNG BỘ
          // để luôn trỏ tới cùng 1 message (không phụ thuộc thứ tự event trong buffer).
          if (event.messageId > current.latestMessageId) {
            current.latestMessageId = event.messageId
            current.latestSenderId = event.senderId
          }
          current.senders.add(event.senderId)
        } else {
          groups.set(event.channelId, {
            workspaceId: event.workspaceId,
            type: event.type,
            latestMessageId: event.messageId,
            latestSenderId: event.senderId,
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

        // Loại người gửi khỏi recipients:
        // count của họ được tính từ lastReadMessageId (chưa được update khi họ tự gửi)
        // → nếu không loại, họ sẽ thấy badge cho chính tin mình vừa gửi.
        const recipients = members.filter((user) => !group.senders.has(user))
        if (recipients.length === 0) continue

        const countMap = await getUnreadCounts(channelId, recipients)

        for (const userId of recipients) {
          const count = countMap.get(userId) ?? 0
          if (count === 0) continue // không có tin chưa đọc → không cần badge

          const payload: ChannelUnreadPayload = {
            channelId: String(channelId),
            workspaceId: group.workspaceId === null ? null : String(group.workspaceId),
            type: group.type,
            count,
            lastMessageId: String(group.latestMessageId),
            senderId: String(group.latestSenderId)
          }

          io.to(Socket_Room.user(String(userId))).emit('channel_unread', payload)
        }

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
// Nhiều tin nhắn trong 1 giây gom thành 1 job, xử lý 1 lần, emit badge 1 lần cho mỗi người — thay vì mỗi tin nhắn bắn 1 event.
