import { NotificationType } from '~/constants/enum'

export interface CreateNotificationBody {
  userId: bigint
  type: NotificationType
  title: string
  body?: string | null
  actorId?: bigint | null
  channelId?: bigint | null
  workspaceId?: bigint | null
  metadata?: Record<string, unknown> | null
}

export interface ListNotificationsParams {
  userId: bigint
  page: number
  limit: number
}
