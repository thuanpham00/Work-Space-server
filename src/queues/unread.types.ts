import { ChannelType } from '~/constants/enum'

export interface UnreadEvent {
  channelId: number
  /** null = channel DM (không thuộc workspace nào) */
  workspaceId: number | null
  /** Người gửi message này */
  senderId: number
  /** Id của message vừa tạo */
  messageId: number
  createdAt: string
  /** ChannelType: 'TEXT' | 'VOICE' | 'DM' */
  type: ChannelType
}

export interface UnreadBatchJob {
  events: UnreadEvent[]
  // Số lần job đã bị defer vì io chưa sẵn sàng.
  // Tự quản lý vì path moveToDelayed + DelayedError KHÔNG tăng attemptsMade của BullMQ.
  ioRetries?: number
}

export interface ChannelUnreadPayload {
  channelId: string
  /** null = channel DM */
  workspaceId: string | null
  type: ChannelType
  /** Số tin nhắn chưa đọc của user này trong channel này */
  count: number
  lastMessageId: string
  /** Sender của message MỚI NHẤT (FE dùng để bỏ qua event do chính mình gửi) */
  senderId: string
}
