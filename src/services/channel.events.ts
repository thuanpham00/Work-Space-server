import databaseServices from '~/services/database.services'
import { ChannelMemberRole, MemberStatus, NotificationType } from '~/constants/enum'
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

/** Socket chung báo cho ADMIN về mọi biến động join-request của B (gộp received cũ vào đây) */
export interface ChannelRequestWithdrawnPayload extends ChannelEventBase {
  type: 'join'
  status: 'PENDING_REQUEST' | 'CANCELED' | 'ACTIVE' | 'LEFT'
  action: 'requested' | 'cancelled' | 'approved' | 'rejected'
  /** B — người gửi / hủy / được duyệt / bị từ chối */
  actorId: string
  requesterId: string
  requesterName: string | null
  requesterAvatar?: string | null
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

/**
 * Lấy toàn bộ ADMIN ACTIVE của channel (trừ `excludeUserId` nếu có).
 *
 * Dùng chung cho mọi flow join-request cần báo cho A:
 * sent / cancelled / approved / rejected.
 */
export const getChannelAdminIds = async (channelId: bigint, excludeUserId?: bigint | null): Promise<bigint[]> => {
  const admins = await databaseServices.prisma.channelMember.findMany({
    where: { channelId, role: ChannelMemberRole.ADMIN, status: MemberStatus.ACTIVE },
    select: { userId: true }
  })

  return admins.map((a) => a.userId).filter((id) => (excludeUserId != null ? id !== excludeUserId : true))
}

/**
 * Bắn socket `channel_request_withdrawn` tới toàn bộ admin trong `adminIds`.
 *
 * Event chung duy nhất cho mọi biến động join-request của B phía A:
 * - requested  → B mới xin vào (A toast + refresh list duyệt)
 * - cancelled / approved / rejected → gỡ B khỏi `ChannelRequestList`
 *   + refresh `notificationList`.
 * Nhận `payload` làm tham số, event cố định để khỏi phân tán handler client.
 */
export const emitToChannelAdmins = (adminIds: bigint[], payload: unknown): void => {
  for (const adminId of adminIds) {
    emitToUser(adminId, 'channel_request_withdrawn', payload)
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
 * → B (người gửi): nhận notification "Bạn đã gửi yêu cầu..." + socket
 *   `channel_request_sent` để đồng bộ các TAB/THIẾT BỊ KHÁC của chính B
 *   (tab khác đang hiển thị nút "Tham gia" cũ → bấm lại sẽ lỗi
 *   "Bạn đã gửi yêu cầu tham gia channel này trước đó").
 * → A (ADMIN của channel): nhận notification "B xin vào kênh X" + socket
 *   `channel_request_withdrawn` (action = 'requested') để refresh
 *   `ChannelRequestList` + toast.
 */
export const notifyChannelRequestSent = async (params: { channelId: bigint; userId: bigint }): Promise<void> => {
  try {
    const [ctx, requester] = await Promise.all([getChannelContext(params.channelId), getUserBrief(params.userId)])

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

    // ---- Báo cho A (toàn bộ ADMIN ACTIVE của channel, trừ chính B) ----
    const adminIds = await getChannelAdminIds(params.channelId, params.userId)
    if (adminIds.length === 0) return

    await Promise.all(
      adminIds.map((adminId) =>
        pushNotification({
          userId: adminId,
          type: NotificationType.CHANNEL_REQUEST_SENT,
          title: `${requester.name} xin tham gia ${ctx.channelName ?? 'kênh chat'}`,
          body: `${requester.name} vừa gửi yêu cầu tham gia ${ctx.channelName ?? 'kênh chat'}`,
          actorId: params.userId,
          channelId: params.channelId,
          workspaceId: ctx.workspaceId ? BigInt(ctx.workspaceId) : null,
          metadata: { requestedById: params.userId.toString(), inviteToken: ctx.inviteToken }
        })
      )
    )

    emitToChannelAdmins(adminIds, {
      ...ctx,
      type: 'join',
      status: 'PENDING_REQUEST',
      action: 'requested',
      actorId: params.userId.toString(),
      requesterId: requester.id,
      requesterName: requester.name,
      requesterAvatar: requester.avatar
    })
  } catch (err) {
    console.error('[channel.events] notifyChannelRequestSent thất bại:', err)
  }
}

/**
 * Flow: User hủy yêu cầu tham gia channel (PENDING_REQUEST → CANCELED).
 *
 * → B (người hủy): xoá notification "đã gửi yêu cầu" của chính B + socket
 *   `channel_request_cancelled` để đồng bộ các tab/thiết bị khác của B
 *   (nút "Hủy yêu cầu" → "Tham gia"). Giữ lại sẽ khiến B thấy
 *   "đang chờ được duyệt" trong khi đã hủy → sai trạng thái.
 *   (Tương tự notifyChannelInviteRevoked → xoá notification CHANNEL_INVITED.)
 * → A (ADMIN của channel): xoá notification "B xin vào kênh X" + socket
 *   `channel_request_withdrawn` để refresh `ChannelRequestList` (gỡ B khỏi
 *   list duyệt). Nếu không xoá, A vẫn thấy "B xin tham gia" trong khi B đã
 *   rút → bấm Duyệt sẽ lỗi "không có yêu cầu tham gia".
 */
export const notifyChannelRequestCancelled = async (params: { channelId: bigint; userId: bigint }): Promise<void> => {
  try {
    const [ctx, requester] = await Promise.all([getChannelContext(params.channelId), getUserBrief(params.userId)])

    await notificationServices.deleteChannelRequestSentNotifications(params.userId, params.channelId)

    emitToUser(params.userId, 'channel_request_cancelled', {
      ...ctx,
      type: 'join',
      status: 'CANCELED',
      action: 'cancelled',
      actorId: params.userId.toString()
    })

    // ---- Gỡ ở phía A (toàn bộ ADMIN ACTIVE của channel, trừ chính B) ----
    const adminIds = await getChannelAdminIds(params.channelId, params.userId)
    if (adminIds.length === 0) return

    await notificationServices.deleteChannelRequestReceivedNotifications(adminIds, params.channelId, params.userId)

    emitToChannelAdmins(adminIds, {
      ...ctx,
      type: 'join',
      status: 'CANCELED',
      action: 'cancelled',
      actorId: params.userId.toString(),
      requesterId: requester.id,
      requesterName: requester.name
    })
  } catch (err) {
    console.error('[channel.events] notifyChannelRequestCancelled thất bại:', err)
  }
}

/**
 * Flow: Admin duyệt yêu cầu tham gia (PENDING_REQUEST → ACTIVE).
 *
 * → B (người xin): nhận notification + socket `channel_request_resolved`
 *   (toast "đã được duyệt" + refresh sidebar).
 * → A (toàn bộ ADMIN, gồm cả tab khác của chính người duyệt): xoá
 *   notification "B xin vào" + socket `channel_request_withdrawn` để gỡ B
 *   khỏi `ChannelRequestList`. Tái dùng event withdrawn sẵn có nên client A
 *   không cần thêm handler mới.
 */
export const notifyChannelJoinApproved = async (params: {
  channelId: bigint
  userId: bigint
  approvedById: bigint
}): Promise<void> => {
  try {
    const [ctx, approver, requester] = await Promise.all([
      getChannelContext(params.channelId),
      getUserBrief(params.approvedById),
      getUserBrief(params.userId)
    ])

    // Xoá "Bạn đã gửi yêu cầu..." của B — request đã xong, giữ lại sẽ khiến
    // chuông B tồn 2 dòng SENT + APPROVED cho cùng 1 channel (rác + sai trạng
    // thái "đang chờ" trong khi đã ACTIVE). Chỉ giữ lại dòng kết quả bên dưới.
    await notificationServices.deleteChannelRequestSentNotifications(params.userId, params.channelId)

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

    // ---- Đồng bộ phía A: request đã xong → gỡ khỏi list duyệt của mọi admin ----
    const adminIds = await getChannelAdminIds(params.channelId)
    if (adminIds.length === 0) return

    await notificationServices.deleteChannelRequestReceivedNotifications(adminIds, params.channelId, params.userId)

    emitToChannelAdmins(adminIds, {
      ...ctx,
      type: 'join',
      status: 'ACTIVE',
      action: 'approved',
      actorId: params.userId.toString(),
      requesterId: requester.id,
      requesterName: requester.name
    })
  } catch (err) {
    console.error('[channel.events] notifyChannelJoinApproved thất bại:', err)
  }
}

/**
 * Flow: Admin từ chối yêu cầu tham gia (PENDING_REQUEST → LEFT).
 *
 * → B (người xin): nhận notification + socket `channel_request_resolved`
 *   (toast "bị từ chối").
 * → A (toàn bộ ADMIN): xoá notification "B xin vào" + socket
 *   `channel_request_withdrawn` để gỡ B khỏi `ChannelRequestList`.
 */
export const notifyChannelJoinRejected = async (params: {
  channelId: bigint
  userId: bigint
  rejectedById: bigint
}): Promise<void> => {
  try {
    const [ctx, rejecter, requester] = await Promise.all([
      getChannelContext(params.channelId),
      getUserBrief(params.rejectedById),
      getUserBrief(params.userId)
    ])

    // Xoá "Bạn đã gửi yêu cầu..." của B — request đã xong (bị từ chối), giữ
    // lại sẽ khiến chuông B tồn 2 dòng SENT + REJECTED (rác + sai trạng thái).
    await notificationServices.deleteChannelRequestSentNotifications(params.userId, params.channelId)

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

    // ---- Đồng bộ phía A: request đã xong → gỡ khỏi list duyệt của mọi admin ----
    const adminIds = await getChannelAdminIds(params.channelId)
    if (adminIds.length === 0) return

    await notificationServices.deleteChannelRequestReceivedNotifications(adminIds, params.channelId, params.userId)

    emitToChannelAdmins(adminIds, {
      ...ctx,
      type: 'join',
      status: 'LEFT',
      action: 'rejected',
      actorId: params.userId.toString(),
      requesterId: requester.id,
      requesterName: requester.name
    })
  } catch (err) {
    console.error('[channel.events] notifyChannelJoinRejected thất bại:', err)
  }
}
