import { Response } from 'express'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { ApiResponse, TokenPayload } from '~/models/responses/user.responses'
import type { NotificationListResponse } from '~/models/responses/notification.response'
import { emitToUser } from '~/services/channel.events'
import notificationServices from '~/services/notification.services'

export const listNotificationsController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload
  const { page, limit } = req.query as unknown as {
    page: string
    limit: string
  }

  const result = await notificationServices.listNotifications({
    userId: BigInt(user_id),
    page: Number(page),
    limit: Number(limit)
  })

  const response: ApiResponse<NotificationListResponse> = {
    message: 'Lấy danh sách thông báo thành công',
    data: result
  }

  res.json(response)
}

export const getUnreadCountController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload

  const unreadCount = await notificationServices.countUnread(BigInt(user_id))

  res.json({
    message: 'Lấy số lượng thông báo chưa đọc thành công',
    data: { unreadCount }
  })
}

export const markNotificationAsReadController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload
  const { id } = req.params as { id: string }

  const notification = await notificationServices.markAsRead(BigInt(id), BigInt(user_id))

  const unreadCount = await notificationServices.countUnread(BigInt(user_id))

  // Đồng bộ tab/thiết bị khác của cùng user
  emitToUser(user_id, 'notification_read', {
    notificationId: notification.id,
    unreadCount
  })

  res.json({
    message: 'Đánh dấu thông báo đã đọc thành công',
    data: { notification, unreadCount }
  })
}

export const markAllNotificationsAsReadController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload

  const updatedCount = await notificationServices.markAllAsRead(BigInt(user_id))

  // Đồng bộ tab/thiết bị khác của cùng user
  emitToUser(user_id, 'notification_read_all', { unreadCount: 0 })

  res.json({
    message: 'Đánh dấu toàn bộ thông báo đã đọc thành công',
    data: { updatedCount, unreadCount: 0 }
  })
}
