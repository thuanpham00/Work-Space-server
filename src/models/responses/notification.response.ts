import { NotificationType } from '~/constants/enum'

export interface NotificationResponse {
  id: string
  type: NotificationType
  title: string
  body: string | null
  actorId: string | null
  actorName: string | null
  actorAvatar: string | null
  channelId: string | null
  channelName: string | null
  workspaceId: string | null
  metadata: Record<string, unknown> | null
  isRead: boolean
  readAt: string | null
  createdAt: string
}

export interface NotificationListResponse {
  notifications: NotificationResponse[]
  total: number
  page: number
  limit: number
  totalPages: number
  unreadCount: number
}
