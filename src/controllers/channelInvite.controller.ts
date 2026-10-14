import { Response } from 'express'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { TokenPayload } from '~/models/responses/user.responses'
import channelServices from '~/services/channel.services'
import channelInviteServices from '~/services/channelInvite.services'

export const getChannelByInviteCodeController = async (req: AuthenticatedRequest, res: Response) => {
  const { code } = req.params
  const { user_id: userId } = req.decode_authorization as TokenPayload

  if (!code) {
    throw new ErrorWithStatus({
      message: 'Thiếu code',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const { channelId } = await channelInviteServices.getChannelByInviteCode(code as string)

  const { channel } = await channelServices.getChannelStatus(BigInt(channelId), BigInt(userId))

  res.json({
    message: 'Lấy trạng thái channel thành công',
    data: {
      channel
    }
  })
}
