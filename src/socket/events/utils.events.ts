import { NotificationType } from '~/constants/enum'
import { NotificationResponse } from '~/models/responses/notification.response'
import notificationServices from '~/services/notification.services'
import { getIO } from '~/socket/socket-instance'
import { Socket_Room } from '~/socket/utils'

/**
 * Emit tới đúng 1 user qua room `user:{id}`.
 *
 * Room `user:{id}` luôn được join lúc connect:
 *   socket.join(Socket_Room.user(String(userId)))
 * → không phụ thuộc user đang mở channel nào.
 */
export const emitToUser = (userId: bigint | string, event: string, payload: unknown): void => {
  const io = getIO()

  if (!io) return

  try {
    io.to(Socket_Room.user(userId.toString())).emit(event, payload)
  } catch (err) {
    console.error(`[channel.events] emit "${event}" tới user ${userId} thất bại:`, err)
  }
}

export const pushNotification = async (params: {
  userId: bigint
  type: NotificationType
  title: string
  body?: string | null
  actorId?: bigint | null
  channelId?: bigint | null
  workspaceId?: bigint | null
  metadata?: Record<string, unknown> | null
}): Promise<NotificationResponse | null> => {
  const notification = await notificationServices.createNotification({
    userId: params.userId,
    type: params.type,
    title: params.title,
    body: params.body ?? null,
    actorId: params.actorId ?? null,
    channelId: params.channelId ?? null,
    workspaceId: params.workspaceId ?? null,
    metadata: params.metadata ?? null
  })

  if (!notification) return null

  return notification
}

export const emitToUserAndPushNotification = async (params: {
  userId: bigint
  type: NotificationType
  title: string
  body?: string | null
  actorId?: bigint | null
  channelId?: bigint | null
  workspaceId?: bigint | null
  metadata?: Record<string, unknown> | null
  event?: string
  payload?: unknown
}): Promise<NotificationResponse | null> => {
  const notification = await pushNotification({
    userId: params.userId,
    type: params.type,
    title: params.title,
    body: params.body ?? null,
    actorId: params.actorId ?? null,
    channelId: params.channelId ?? null,
    workspaceId: params.workspaceId ?? null,
    metadata: params.metadata ?? null
  })

  if (!notification) return null

  // Realtime event (tuỳ chọn) — payload mặc định là notification vừa tạo.
  if (params.event) {
    emitToUser(params.userId, params.event, params.payload ?? notification)
  }

  return notification
}
