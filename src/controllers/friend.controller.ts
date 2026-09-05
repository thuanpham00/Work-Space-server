import { Response } from 'express'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { FriendResponse } from '~/models/responses/friend.responses'
import { ApiResponse, TokenPayload } from '~/models/responses/user.responses'
import friendServices from '~/services/friend.services'

// lấy ds bạn bè dựa trên trạng thái (chờ xác nhận, đã gửi yêu cầu kb cho user, tất cả) dựa trên token của user hiện tại
export const getAllFriendsController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload
  const { status, search } = req.query as { status?: string; search?: string }

  const friends = await friendServices.getAllFriends(BigInt(user_id), status as string, search as string)

  const response: ApiResponse<{ friends: FriendResponse[]; total: number }> = {
    message: 'Lấy danh sách bạn bè thành công',
    data: {
      friends: friends as unknown as FriendResponse[],
      total: friends.length
    }
  }

  res.json(response)
}

export const getUnreadFriendsController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload
  const unreadFriends = await friendServices.getUnreadFriends(BigInt(user_id))

  res.json({
    message: 'Lấy trạng thái unread của bạn bè thành công',
    data: {
      unreadFriends
    }
  })
}

export const addFriendController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload
  const { friendId } = req.body as { friendId: string }

  if (user_id === friendId) {
    throw new ErrorWithStatus({
      message: 'Bạn không thể thêm chính mình làm bạn bè',
      status: httpStatus.BAD_REQUESTED
    })
  }

  await friendServices.addFriend(BigInt(user_id), BigInt(friendId))

  res.json({
    message: 'Yêu cầu kết bạn đã được gửi thành công'
  })
}

export const acceptFriendController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload
  const { friendId } = req.body as { friendId: string }

  if (user_id === friendId) {
    throw new ErrorWithStatus({
      message: 'Bạn không thể đồng ý kết bạn với chính mình',
      status: httpStatus.BAD_REQUESTED
    })
  }

  await friendServices.acceptFriend(BigInt(user_id), BigInt(friendId))

  res.json({
    message: 'Đồng ý kết bạn thành công'
  })
}

export const rejectFriendController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload
  const { friendId } = req.body as { friendId: string }

  if (user_id === friendId) {
    throw new ErrorWithStatus({
      message: 'Bạn không thể từ chối kết bạn với chính mình',
      status: httpStatus.BAD_REQUESTED
    })
  }

  await friendServices.rejectFriend(BigInt(user_id), BigInt(friendId))

  res.json({
    message: 'Từ chối kết bạn thành công'
  })
}
