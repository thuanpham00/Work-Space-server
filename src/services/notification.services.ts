/* eslint-disable @typescript-eslint/no-explicit-any */
import { NotificationType } from '~/constants/enum'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import type { NotificationListResponse, NotificationResponse } from '~/models/responses/notification.response'
import type { CreateNotificationBody, ListNotificationsParams } from '~/models/requests/notification.request'
import databaseServices from '~/services/database.services'
import type { Prisma } from '~/generated/prisma/client'

const notificationSelect = {
  id: true,
  type: true,
  title: true,
  body: true,
  actorId: true,
  channelId: true,
  workspaceId: true,
  metadata: true,
  isRead: true,
  readAt: true,
  createdAt: true,
  actor: {
    select: { fullName: true, displayName: true, username: true, avatar: true }
  },
  channel: {
    select: { name: true }
  }
} as const

type NotificationRow = Prisma.NotificationGetPayload<{ select: typeof notificationSelect }>

class NotificationService {
  private toNotificationResponse(row: NotificationRow): NotificationResponse {
    return {
      ...row,
      id: row.id.toString(),
      type: row.type as NotificationType,
      actorId: row.actorId ? row.actorId.toString() : null,
      actorName: row.actor?.fullName || row.actor?.displayName || row.actor?.username || null,
      actorAvatar: row.actor?.avatar ?? null,
      channelId: row.channelId ? row.channelId.toString() : null,
      channelName: row.channel?.name ?? null,
      workspaceId: row.workspaceId ? row.workspaceId.toString() : null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString()
    }
  }

  async createNotification(input: CreateNotificationBody): Promise<NotificationResponse | null> {
    try {
      const row = await databaseServices.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          actorId: input.actorId ?? null,
          channelId: input.channelId ?? null,
          workspaceId: input.workspaceId ?? null,
          metadata: (input.metadata ?? undefined) as any
        },
        select: notificationSelect
      })

      return this.toNotificationResponse(row)
    } catch (err) {
      console.error('[notification.services] createNotification thất bại:', err)
      return null
    }
  }

  async createManyNotifications(userIds: bigint[], input: Omit<CreateNotificationBody, 'userId'>): Promise<number> {
    if (userIds.length === 0) return 0

    try {
      const result = await databaseServices.prisma.notification.createMany({
        data: userIds.map((userId) => ({
          userId,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          actorId: input.actorId ?? null,
          channelId: input.channelId ?? null,
          workspaceId: input.workspaceId ?? null,
          metadata: (input.metadata ?? undefined) as any
        }))
      })

      return result.count
    } catch (err) {
      console.error('[notification.services] createManyNotifications thất bại:', err)
      return 0
    }
  }

  async listNotifications(params: ListNotificationsParams): Promise<NotificationListResponse> {
    const { userId, page, limit } = params

    const where: any = {
      userId
    }

    const [rows, total, unreadCount] = await Promise.all([
      databaseServices.prisma.notification.findMany({
        where,
        select: notificationSelect,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: (page - 1) * limit
      }),
      databaseServices.prisma.notification.count({ where }),
      databaseServices.prisma.notification.count({ where: { userId, isRead: false } })
    ])

    return {
      notifications: rows.map((row) => this.toNotificationResponse(row)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      unreadCount
    }
  }

  async countUnread(userId: bigint) {
    return await databaseServices.prisma.notification.count({
      where: { userId, isRead: false }
    })
  }

  async markAsRead(notificationId: bigint, userId: bigint) {
    const existing = await databaseServices.prisma.notification.findFirst({
      where: { id: notificationId, userId },
      select: notificationSelect
    })

    if (!existing) {
      throw new ErrorWithStatus({
        message: 'Không tìm thấy thông báo',
        status: httpStatus.NOTFOUND
      })
    }

    if (!existing.isRead) {
      await databaseServices.prisma.notification.update({
        where: { id: notificationId },
        data: { isRead: true, readAt: new Date() }
      })
    }

    return this.toNotificationResponse({ ...existing, isRead: true, readAt: existing.readAt ?? new Date() })
  }

  async markAllAsRead(userId: bigint) {
    const result = await databaseServices.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() }
    })

    return result.count
  }
}

export default new NotificationService()
