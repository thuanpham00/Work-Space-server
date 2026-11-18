import { NotificationType } from '~/constants/enum'
import notificationServices from '~/services/notification.services'
import { getUserBrief } from '~/services/redis.services'
import { emitToUser, emitToUserAndPushNotification } from '~/socket/events/utils.events'

/**
 * Hành động xảy ra với lời mời kết bạn.
 *
 * - `accepted`  → B đồng ý lời mời của A.
 * - `rejected`  → B từ chối lời mời của A.
 * - `cancelled` → A hủy lời mời đã gửi cho B.
 */
export type FriendRequestAction = 'accepted' | 'rejected' | 'cancelled'

/**
 * Payload dùng chung cho mọi biến động của lời mời kết bạn.
 *
 * Quy ước: `friendId` / `friendName` / `friendAvatar` LUÔN mang nghĩa
 * **"đối tác của lời mời"** — tức là người KHÁC với user đang nhận event.
 * Nhờ vậy client không cần tự suy ra ai là ai, cũng không cần `check actorId`.
 *
 * Ví dụ flow A gửi → B nhận:
 * - B nhận `friend_request_received` → `friendId` = A (A là người gửi).
 * - A nhận `friend_request_sent`     → `friendId` = B (B là người nhận).
 */
export interface FriendRequestPayload {
  /** Id của đối tác (người còn lại trong lời mời) */
  friendId: string
  /** Tên hiển thị của đối tác */
  friendName: string
  /** Avatar của đối tác */
  friendAvatar: string | null
  /** Hành động vừa xảy ra — `PENDING` cho lúc mới gửi */
  action: FriendRequestAction | 'PENDING'
}

/**
 * Flow: A gửi lời mời kết bạn cho B.
 *
 * → B nhận notification "A đã gửi lời mời kết bạn" + socket
 *   `friend_request_received` (refresh danh sách yêu cầu + chuông).
 * → A nhận socket `friend_request_sent` để biết lời mời đã gửi thành công
 *   (đồng bộ các tab/thiết bị khác của chính A).
 */
export const emitToAddFriend = async (userId: bigint, friendId: bigint): Promise<void> => {
  try {
    const [requester, addressee] = await Promise.all([getUserBrief(userId), getUserBrief(friendId)])

    // 1. Notification cho B (người nhận lời mời), actor = A (người gửi)
    await emitToUserAndPushNotification({
      userId: friendId,
      type: NotificationType.FRIEND_REQUEST,
      title: 'Bạn có lời mời kết bạn mới',
      body: `${requester.name} đã gửi lời mời kết bạn`,
      actorId: userId,
      metadata: { requesterId: userId.toString(), friendId: friendId.toString() },
      event: 'friend_request_received',
      payload: {
        friendId: requester.id,
        friendName: requester.name,
        friendAvatar: requester.avatar,
        action: 'PENDING'
      } satisfies FriendRequestPayload
    })

    // 2. Event realtime cho A (người gửi lời mời)
    emitToUser(userId, 'friend_request_sent', {
      friendId: addressee.id,
      friendName: addressee.name,
      friendAvatar: addressee.avatar,
      action: 'PENDING'
    } satisfies FriendRequestPayload)
  } catch (err) {
    console.error('[friend.event] emitToAddFriend thất bại:', err)
  }
}

/**
 * Flow: A hủy lời mời kết bạn đã gửi cho B.
 *
 * → Xoá notification `FRIEND_REQUEST` ở phía B (nơi lời mời của A đã tồn tại),
 *   nếu không B vẫn thấy "A đã gửi lời mời kết bạn" dù yêu cầu đã bị hủy.
 * → Socket `friend_request_resolved` cho A (đồng bộ tab/thiết bị của A).
 * → Socket `friend_request_withdrawn` cho B (gỡ khỏi list "yêu cầu đã nhận").
 *
 * Lưu ý: A là người gửi nên A KHÔNG có notification nào — chỉ B (người nhận)
 * mới giữ notification `FRIEND_REQUEST` với `userId = B`, `actorId = A`.
 */
export const emitToCancelFriendRequest = async (userId: bigint, friendId: bigint): Promise<void> => {
  try {
    const [canceller, addressee] = await Promise.all([getUserBrief(userId), getUserBrief(friendId)])

    // 1. Xoá notification lời mời còn sót ở phía B (người nhận), actor = A (người gửi)
    await notificationServices.deleteFriendRequestNotifications(friendId, userId)

    // 2. Event realtime cho A (người hủy) — đồng bộ tab/thiết bị khác của A
    emitToUser(userId, 'friend_request_resolved', {
      friendId: addressee.id,
      friendName: addressee.name,
      friendAvatar: addressee.avatar,
      action: 'cancelled'
    } satisfies FriendRequestPayload)

    // 3. Event realtime cho B (người nhận lời mời) — refresh list "yêu cầu đã nhận"
    emitToUser(friendId, 'friend_request_withdrawn', {
      friendId: canceller.id,
      friendName: canceller.name,
      friendAvatar: canceller.avatar,
      action: 'cancelled'
    } satisfies FriendRequestPayload)
  } catch (err) {
    console.error('[friend.event] emitToCancelFriendRequest thất bại:', err)
  }
}

/**
 * Flow: B đồng ý kết bạn với A.
 *
 * → Xoá notification `FRIEND_REQUEST` ở phía B (lời mời gốc của A) — bắt buộc,
 *   nếu không B sẽ thấy 2 dòng: "A đã gửi lời mời" (cũ) + "A đã đồng ý" (mới).
 * → A nhận notification "B đã đồng ý kết bạn" + socket `friend_request_resolved`.
 * → B nhận socket `friend_request_resolved` để refresh danh sách bạn bè.
 */
export const emitToAcceptFriend = async (userId: bigint, friendId: bigint): Promise<void> => {
  try {
    const [accepter, receiver] = await Promise.all([getUserBrief(userId), getUserBrief(friendId)])

    // 1. Xoá notification lời mời gốc ở phía B (người nhận), actor = A (người gửi)
    await notificationServices.deleteFriendRequestNotifications(friendId, userId)

    // 2. Notification cho A (người gửi lời mời), actor = B (người vừa đồng ý)
    await emitToUserAndPushNotification({
      userId: friendId,
      type: NotificationType.FRIEND_REQUEST_ACCEPTED,
      title: 'Lời mời kết bạn đã được chấp nhận',
      body: `${accepter.name} đã đồng ý kết bạn với bạn`,
      actorId: userId,
      metadata: { acceptedById: userId.toString(), friendId: friendId.toString() },
      event: 'friend_request_resolved',
      payload: {
        friendId: accepter.id,
        friendName: accepter.name,
        friendAvatar: accepter.avatar,
        action: 'accepted'
      } satisfies FriendRequestPayload
    })

    // 3. Event realtime cho B (người vừa đồng ý) — refresh danh sách bạn bè
    emitToUser(userId, 'friend_request_resolved', {
      friendId: receiver.id,
      friendName: receiver.name,
      friendAvatar: receiver.avatar,
      action: 'accepted'
    } satisfies FriendRequestPayload)
  } catch (err) {
    console.error('[friend.event] emitToAcceptFriend thất bại:', err)
  }
}

/**
 * Flow: B từ chối lời mời kết bạn của A.
 *
 * → Xoá notification `FRIEND_REQUEST` ở phía B (lời mời gốc của A) — nếu không
 *   B vẫn thấy "A đã gửi lời mời kết bạn" dù yêu cầu đã bị từ chối.
 * → Socket `friend_request_resolved` cho A (biết bị từ chối).
 * → Socket `friend_request_withdrawn` cho B (gỡ khỏi list "yêu cầu đã nhận",
 *   đồng bộ các tab/thiết bị khác của chính B).
 *
 * Lưu ý: A là người gửi nên A KHÔNG có notification nào — chỉ B (người nhận)
 * mới giữ notification `FRIEND_REQUEST` với `userId = B`, `actorId = A`.
 */
export const emitToRejectFriend = async (userId: bigint, friendId: bigint): Promise<void> => {
  try {
    const [rejector, requester] = await Promise.all([getUserBrief(userId), getUserBrief(friendId)])

    // 1. Xoá notification lời mời còn sót ở phía B (người nhận), actor = A (người gửi)
    await notificationServices.deleteFriendRequestNotifications(friendId, userId)

    // 2. Event realtime cho A (người gửi lời mời) — biết bị từ chối
    emitToUser(friendId, 'friend_request_resolved', {
      friendId: rejector.id,
      friendName: rejector.name,
      friendAvatar: rejector.avatar,
      action: 'rejected'
    } satisfies FriendRequestPayload)

    // 3. Event realtime cho B (người vừa từ chối) — đồng bộ tab/thiết bị khác
    emitToUser(userId, 'friend_request_withdrawn', {
      friendId: requester.id,
      friendName: requester.name,
      friendAvatar: requester.avatar,
      action: 'rejected'
    } satisfies FriendRequestPayload)
  } catch (err) {
    console.error('[friend.event] emitToRejectFriend thất bại:', err)
  }
}
