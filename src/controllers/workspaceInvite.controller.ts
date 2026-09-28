import { Response } from 'express'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { ApiResponse } from '~/models/responses/user.responses'
import { WorkspaceByInviteCodeResponse } from '~/models/responses/workspaceInvite.response'
import workspaceInviteServices from '~/services/workspaceInvite.services'

export const getWorkspaceByInviteCodeController = async (req: AuthenticatedRequest, res: Response) => {
  const { code } = req.params

  if (!code) {
    throw new ErrorWithStatus({
      message: 'Thiếu code',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const codeRaw = Array.isArray(code) ? code[0] : code

  const data = await workspaceInviteServices.getWorkspaceByInviteCode(codeRaw)

  const response: ApiResponse<WorkspaceByInviteCodeResponse> = {
    message: 'Lấy thông tin workspace từ invite code thành công',
    data: data as WorkspaceByInviteCodeResponse
  }

  res.json(response)
}
