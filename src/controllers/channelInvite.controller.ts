import { Response } from 'express'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { ChannelByInviteCodeResponse } from '~/models/responses/channelInvite.response'
import { ApiResponse } from '~/models/responses/user.responses'
import channelInviteServices from '~/services/channelInvite.services'

export const getChannelByInviteCodeController = async (req: AuthenticatedRequest, res: Response) => {
  const { code } = req.params

  if (!code) {
    throw new ErrorWithStatus({
      message: 'Thiếu code',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const data = await channelInviteServices.getChannelByInviteCode(code as string)

  const response: ApiResponse<ChannelByInviteCodeResponse> = {
    message: 'Lấy thông tin channel từ invite code thành công',
    data: data as ChannelByInviteCodeResponse
  }

  res.json(response)
}
