import { Response } from 'express'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { FriendResponse } from '~/models/responses/friend.responses'
import { ApiResponse, TokenPayload } from '~/models/responses/user.responses'
import channelServices from '~/services/channel.services'

export const getDirectMessageChannelsController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload

  const channels = await channelServices.getDirectMessageChannels(BigInt(user_id))
  console.log(channels)
  const response: ApiResponse<{ channels: FriendResponse[]; total: number }> = {
    message: 'Lấy danh sách channels thành công',
    data: {
      channels: channels as unknown as FriendResponse[],
      total: channels.length
    }
  }

  res.json(response)
}
