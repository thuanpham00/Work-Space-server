import { Request, Response } from 'express'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { ApiResponse, TokenPayload } from '~/models/responses/user.responses'
import { Workspace, WorkspaceMember } from '~/models/responses/workspace.response'
import workspaceServices from '~/services/workspace.services'

export const getWorkspaceUserController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload
  const workspaces = await workspaceServices.getWorkspacesOfUser(BigInt(user_id))

  const response: ApiResponse<{ workspaces: Workspace[]; total: number }> = {
    message: 'Lấy danh sách workspace thành công',
    data: {
      workspaces: workspaces,
      total: workspaces.length
    }
  }

  res.json(response)
}

export const getWorkspaceDetailController = async (req: AuthenticatedRequest, res: Response) => {
  const { id: workspaceId } = req.params
  const workspaces = await workspaceServices.getWorkSpaceDetail(BigInt(workspaceId as string))

  if (!workspaces) return res.status(404).json({ message: 'Workspace not found' })

  const response: ApiResponse<{ workspace: Workspace }> = {
    message: 'Lấy chi tiết workspace thành công',
    data: {
      workspace: workspaces
    }
  }

  res.json(response)
}

// lấy thông tin user và trạng thái friend của user đó với user hiện tại
export const getWorkspaceMemberStatusController = async (req: Request, res: Response) => {
  const { workspaceId } = req.params
  const { user_id } = req.decode_authorization as TokenPayload

  if (!workspaceId || !user_id) {
    throw new ErrorWithStatus({
      message: 'Thiếu thông tin workspaceId hoặc userId',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const workspace = await workspaceServices.getWorkspaceMemberStatus(BigInt(workspaceId as string), BigInt(user_id))

  const response: ApiResponse<{ workspace: Workspace }> = {
    message: 'Lấy thông tin user thành công',
    data: { workspace: workspace as unknown as Workspace }
  }

  res.json(response)
}

export const requestInviteToWorkspaceController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId } = req.params
  const { user_id } = req.decode_authorization as TokenPayload

  if (!workspaceId || !user_id) {
    throw new ErrorWithStatus({
      message: 'Thiếu thông tin workspaceId hoặc userId',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const result = await workspaceServices.requestToJoinWorkspace(BigInt(workspaceId as string), BigInt(user_id))

  const response: ApiResponse<{ workspaceMember: WorkspaceMember }> = {
    message: 'Gửi yêu cầu tham gia workspace thành công',
    data: { workspaceMember: result as unknown as WorkspaceMember }
  }

  res.json(response)
}
