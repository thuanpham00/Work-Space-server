import databaseServices from '~/services/database.services'
import { NotificationType } from '~/constants/enum'
import notificationServices from '~/services/notification.services'
import type { NotificationResponse } from '~/models/responses/notification.response'
import { getIO } from '~/socket/socket-instance'
import { Socket_Room } from '~/socket/utils'
import { ChannelInviteStatus } from '~/models/responses/channel.response'

export interface ChannelEventBase {
  channelId: string
  channelName: string | null
  workspaceId: string | null
  inviteToken: string | null
}

export interface ChannelInvitedPayload extends ChannelEventBase {
  type: 'invite'
  invitedById: string
  invitedByName: string
}

/** Lời mời bị admin thu hồi */
export interface ChannelInviteRevokedPayload extends ChannelEventBase {
  type: 'invite'
  revokedById: string
  revokedByName: string
}

/** Yêu cầu tham gia được duyệt / từ chối */
export interface ChannelRequestResolvedPayload extends ChannelEventBase {
  type: 'join'
  status: 'ACTIVE' | 'LEFT'
  action: 'approved' | 'rejected'
  resolvedById: string
  resolvedByName: string
}

/** Lời mời được chính user đó accept / reject */
export interface ChannelInviteResolvedPayload extends ChannelEventBase {
  type: 'invite'
  status: 'ACTIVE' | 'LEFT'
  action: 'accepted' | 'rejected'
  actorId: string
}

/** User vừa gửi yêu cầu tham gia channel (đồng bộ các tab/thiết bị khác) */
export interface ChannelRequestSentPayload extends ChannelEventBase {
  type: 'join'
  status: 'PENDING_REQUEST'
  action: 'requested'
  actorId: string
}

/** User vừa hủy yêu cầu tham gia channel (đồng bộ các tab/thiết bị khác) */
export interface ChannelRequestCancelledPayload extends ChannelEventBase {
  type: 'join'
  status: 'CANCELED'
  action: 'cancelled'
  actorId: string
}

/** Membership trong workspace thay đổi → sidebar cần refresh */
export interface WorkspaceUpdatedPayload {
  workspaceId: string
  channelId: string
  reason: 'joined' | 'left'
}

// ============ HELPERS ============

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

const getChannelContext = async (channelId: bigint): Promise<ChannelEventBase> => {
  const [channel, activeInvite] = await Promise.all([
    databaseServices.prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, name: true, workspaceId: true }
    }),
    databaseServices.prisma.channelInvite.findFirst({
      where: { channelId, status: ChannelInviteStatus.ACTIVE },
      select: { code: true }
    })
  ])

  return {
    channelId: channel?.id.toString() ?? channelId.toString(),
    channelName: channel?.name ?? null,
    workspaceId: channel?.workspaceId ? channel.workspaceId.toString() : null,
    inviteToken: activeInvite?.code ?? null
  }
}

/** Lấy thông tin hiển thị tối thiểu của user (tên + avatar) */
const getUserBrief = async (userId: bigint) => {
  const user = await databaseServices.prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, displayName: true, fullName: true, username: true, avatar: true }
  })

  return {
    id: user?.id.toString() ?? userId.toString(),
    name: user?.fullName || user?.username || 'Người dùng',
    avatar: user?.avatar ?? null
  }
}

const pushNotification = async (params: {
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

/**
 * Flow: Admin gửi lời mời vào channel.
 *
 * → User được mời nhận toast "Bạn được mời vào kênh X" + sidebar refresh.
 */
export const notifyChannelInvited = async (params: {
  channelId: bigint
  userId: bigint
  invitedById: bigint
}): Promise<void> => {
  try {
    const [ctx, inviter] = await Promise.all([getChannelContext(params.channelId), getUserBrief(params.invitedById)])

    // 1. Tạo notification trong DB + emit socket
    await pushNotification({
      userId: params.userId,
      type: NotificationType.CHANNEL_INVITED,
      title: `Bạn được mời vào kênh ${ctx.channelName ?? 'kênh chat'}`,
      body: `${inviter.name} đã mời bạn vào ${ctx.channelName ?? 'kênh chat'}`,
      actorId: params.invitedById,
      channelId: params.channelId,
      workspaceId: ctx.workspaceId ? BigInt(ctx.workspaceId) : null,
      metadata: { invitedById: params.invitedById.toString(), inviteToken: ctx.inviteToken }
    })

    // 2. Event realtime cũ (giữ lại để client invalidate cache)
    emitToUser(params.userId, 'channel_invited', {
      ...ctx,
      type: 'invite',
      invitedById: inviter.id,
      invitedByName: inviter.name,
      invitedByAvatar: inviter.avatar
    })
  } catch (err) {
    console.error('[channel.events] notifyChannelInvited thất bại:', err)
  }
}

/**
 * Flow: Admin thu hồi lời mời.
 *
 * → User bị thu hồi gỡ được trạng thái "đang được mời".
 */
export const notifyChannelInviteRevoked = async (params: {
  channelId: bigint
  userId: bigint
  revokedById: bigint
}): Promise<void> => {
  try {
    const [ctx, revoker] = await Promise.all([getChannelContext(params.channelId), getUserBrief(params.revokedById)])

    await notificationServices.deleteChannelInviteNotifications(params.userId, params.channelId)

    emitToUser(params.userId, 'channel_invite_revoked', {
      ...ctx,
      type: 'invite',
      revokedById: revoker.id,
      revokedByName: revoker.name
    })
  } catch (err) {
    console.error('[channel.events] notifyChannelInviteRevoked thất bại:', err)
  }
}

/**
 * Flow: User accept lời mời (PENDING_INVITE → ACTIVE).
 *
 * → Gửi cho CHÍNH user này để các TAB/THIẾT BỊ KHÁC của cùng user đồng bộ
 *   (tab khác có thể đang hiển thị trạng thái "đang được mời" cũ).
 *   Client sẽ tự bỏ qua toast nếu actor là chính mình.
 * → workspace_updated: membership workspace đổi → sidebar cần refresh.
 */
export const notifyChannelInviteAccepted = async (params: { channelId: bigint; userId: bigint }): Promise<void> => {
  try {
    const ctx = await getChannelContext(params.channelId)

    await pushNotification({
      userId: params.userId,
      type: NotificationType.CHANNEL_INVITE_ACCEPTED,
      title: `Bạn đã được thêm vào kênh ${ctx.channelName ?? 'kênh chat'}`,
      body: `Bạn đã được thêm vào kênh ${ctx.channelName ?? 'kênh chat'}`,
      actorId: params.userId,
      channelId: params.channelId,
      workspaceId: ctx.workspaceId ? BigInt(ctx.workspaceId) : null,
      metadata: { inviteToken: ctx.inviteToken }
    })

    emitToUser(params.userId, 'channel_invite_resolved', {
      ...ctx,
      type: 'invite',
      status: 'ACTIVE',
      action: 'accepted',
      actorId: params.userId.toString()
    })
  } catch (err) {
    console.error('[channel.events] notifyChannelInviteAccepted thất bại:', err)
  }
}

/**
 * Flow: User từ chối lời mời (PENDING_INVITE → LEFT).
 */
export const notifyChannelInviteRejected = async (params: { channelId: bigint; userId: bigint }): Promise<void> => {
  try {
    const ctx = await getChannelContext(params.channelId)

    emitToUser(params.userId, 'channel_invite_resolved', {
      ...ctx,
      type: 'invite',
      status: 'LEFT',
      action: 'rejected',
      actorId: params.userId.toString()
    })
  } catch (err) {
    console.error('[channel.events] notifyChannelInviteRejected thất bại:', err)
  }
}

/**
 * Flow: User gửi yêu cầu tham gia channel (PENDING_REQUEST).
 *
 * → Gửi cho CHÍNH user này để các TAB/THIẾT BỊ KHÁC của cùng user đồng bộ
 *   (tab khác có thể đang hiển thị nút "Tham gia" cũ → bấm lại sẽ lỗi
 *   "Bạn đã gửi yêu cầu tham gia channel này trước đó").
 *   Client sẽ tự bỏ qua toast nếu actor là chính mình.
 * → Notification cho chính B: "Bạn đã gửi yêu cầu tham gia kênh X".
 *   (Phần thông báo cho ADMIN — người duyệt — sẽ bổ sung sau.)
 */
export const notifyChannelRequestSent = async (params: { channelId: bigint; userId: bigint }): Promise<void> => {
  try {
    const ctx = await getChannelContext(params.channelId)

    await pushNotification({
      userId: params.userId,
      type: NotificationType.CHANNEL_REQUEST_SENT,
      title: `Bạn đã gửi yêu cầu tham gia ${ctx.channelName ?? 'kênh chat'}`,
      body: `Yêu cầu tham gia ${ctx.channelName ?? 'kênh chat'} của bạn đã được gửi đi`,
      actorId: params.userId,
      channelId: params.channelId,
      workspaceId: ctx.workspaceId ? BigInt(ctx.workspaceId) : null,
      metadata: { requestedById: params.userId.toString(), inviteToken: ctx.inviteToken }
    })

    emitToUser(params.userId, 'channel_request_sent', {
      ...ctx,
      type: 'join',
      status: 'PENDING_REQUEST',
      action: 'requested',
      actorId: params.userId.toString()
    })
  } catch (err) {
    console.error('[channel.events] notifyChannelRequestSent thất bại:', err)
  }
}

/**
 * Flow: User hủy yêu cầu tham gia channel (PENDING_REQUEST → CANCELED).
 *
 * → Xoá notification "đã gửi yêu cầu" vì đây là hành động B TỰ đảo ngược
 *   lại hành động của chính mình, và KHÔNG có notification kết quả nào đi kèm.
 *   Giữ lại sẽ khiến B thấy "đã gửi yêu cầu" trong khi đã hủy → sai trạng thái.
 *   (Tương tự notifyChannelInviteRevoked → xoá notification CHANNEL_INVITED.)
 * → Đồng bộ các tab/thiết bị khác của cùng user (nút "Hủy yêu cầu" → "Tham gia").
 */
export const notifyChannelRequestCancelled = async (params: { channelId: bigint; userId: bigint }): Promise<void> => {
  try {
    const ctx = await getChannelContext(params.channelId)

    await notificationServices.deleteChannelRequestSentNotifications(params.userId, params.channelId)

    emitToUser(params.userId, 'channel_request_cancelled', {
      ...ctx,
      type: 'join',
      status: 'CANCELED',
      action: 'cancelled',
      actorId: params.userId.toString()
    })
  } catch (err) {
    console.error('[channel.events] notifyChannelRequestCancelled thất bại:', err)
  }
}

/**
 * Flow: Admin duyệt yêu cầu tham gia (PENDING_REQUEST → ACTIVE).
 *
 * → User gửi yêu cầu nhận toast "Yêu cầu của bạn đã được duyệt" +
 *   workspace_updated để sidebar thêm channel mới.
 */
export const notifyChannelJoinApproved = async (params: {
  channelId: bigint
  userId: bigint
  approvedById: bigint
}): Promise<void> => {
  try {
    const [ctx, approver] = await Promise.all([getChannelContext(params.channelId), getUserBrief(params.approvedById)])

    await pushNotification({
      userId: params.userId,
      type: NotificationType.CHANNEL_REQUEST_APPROVED,
      title: `Yêu cầu tham gia ${ctx.channelName ?? 'kênh chat'} đã được duyệt`,
      body: `${approver.name} đã duyệt yêu cầu tham gia của bạn`,
      actorId: params.approvedById,
      channelId: params.channelId,
      workspaceId: ctx.workspaceId ? BigInt(ctx.workspaceId) : null,
      metadata: { inviteToken: ctx.inviteToken }
    })

    emitToUser(params.userId, 'channel_request_resolved', {
      ...ctx,
      type: 'join',
      status: 'ACTIVE',
      action: 'approved',
      resolvedById: approver.id,
      resolvedByName: approver.name
    })

    // Membership workspace đổi (PENDING_REQUEST → ACTIVE) → sidebar cần refresh.
    if (ctx.workspaceId) {
      emitToUser(params.userId, 'workspace_updated', {
        workspaceId: ctx.workspaceId,
        channelId: ctx.channelId,
        reason: 'joined'
      })
    }
  } catch (err) {
    console.error('[channel.events] notifyChannelJoinApproved thất bại:', err)
  }
}

/**
 * Flow: Admin từ chối yêu cầu tham gia (PENDING_REQUEST → LEFT).
 *
 * → User gửi yêu cầu nhận toast "Yêu cầu của bạn đã bị từ chối" +
 *   workspace_updated để sidebar gỡ channel.
 */
export const notifyChannelJoinRejected = async (params: {
  channelId: bigint
  userId: bigint
  rejectedById: bigint
}): Promise<void> => {
  try {
    const [ctx, rejecter] = await Promise.all([getChannelContext(params.channelId), getUserBrief(params.rejectedById)])

    await pushNotification({
      userId: params.userId,
      type: NotificationType.CHANNEL_REQUEST_REJECTED,
      title: `Yêu cầu tham gia ${ctx.channelName ?? 'kênh chat'} bị từ chối`,
      body: `${rejecter.name} đã từ chối yêu cầu tham gia của bạn`,
      actorId: params.rejectedById,
      channelId: params.channelId,
      workspaceId: ctx.workspaceId ? BigInt(ctx.workspaceId) : null,
      metadata: { inviteToken: ctx.inviteToken }
    })

    emitToUser(params.userId, 'channel_request_resolved', {
      ...ctx,
      type: 'join',
      status: 'LEFT',
      action: 'rejected',
      resolvedById: rejecter.id,
      resolvedByName: rejecter.name
    })

    if (ctx.workspaceId) {
      emitToUser(params.userId, 'workspace_updated', {
        workspaceId: ctx.workspaceId,
        channelId: ctx.channelId,
        reason: 'left'
      })
    }
  } catch (err) {
    console.error('[channel.events] notifyChannelJoinRejected thất bại:', err)
  }
}
