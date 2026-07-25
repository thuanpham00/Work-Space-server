import { Response } from 'express'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { ChannelDM } from '~/models/responses/channel.response'
import { FriendResponse } from '~/models/responses/friend.responses'
import { ApiResponse, TokenPayload } from '~/models/responses/user.responses'
import channelServices from '~/services/channel.services'

export const getDirectMessageChannelsController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id: idUser } = req.decode_authorization as TokenPayload
  const { userId: idRecevier } = req.params as { userId: string }

  const channels = await channelServices.getDirectMessageChannelDetail(BigInt(idUser), BigInt(idRecevier))
  const response: ApiResponse<{ channel: ChannelDM | null }> = {
    message: 'Lấy chi tiết channels thành công',
    data: {
      channel: channels as unknown as ChannelDM
    }
  }

  res.json(response)
}

export const getChannelMessagesController = async (req: AuthenticatedRequest, res: Response) => {}
