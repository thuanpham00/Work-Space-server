import { Request, Response } from 'express'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { ApiResponse, TokenPayload } from '~/models/responses/user.responses'
import {
  PaginatedMembers,
  Workspace,
  WorkspaceMember,
  WorkspaceRequestItem,
  WorkspaceRequestsResponse
} from '~/models/responses/workspace.response'
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

export const getWorkspaceMembersController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId } = req.params
  const { user_id } = req.decode_authorization as TokenPayload
  const {
    search = '',
    page = '1',
    limit = '20'
  } = req.query as {
    search?: string
    page?: string
    limit?: string
  }

  if (!workspaceId) {
    throw new ErrorWithStatus({
      message: 'Thiếu workspaceId',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const data = await workspaceServices.getWorkspaceMembers(
    BigInt(workspaceId as string),
    user_id,
    search,
    Number(page) || 1,
    Number(limit) || 20
  )

  const response: ApiResponse<PaginatedMembers> = {
    message: 'Lấy danh sách thành viên workspace thành công',
    data: data as unknown as PaginatedMembers
  }

  res.json(response)
}

export const getWorkspaceRequestsController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId } = req.params
  const { user_id } = req.decode_authorization as TokenPayload

  if (!workspaceId) {
    throw new ErrorWithStatus({
      message: 'Thiếu workspaceId',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const requests = await workspaceServices.getWorkspaceRequests(BigInt(workspaceId as string), user_id)

  const inviteCount = requests.filter((r) => r.type === 'invite').length
  const joinCount = requests.filter((r) => r.type === 'join').length

  const response: ApiResponse<WorkspaceRequestsResponse> = {
    message: 'Lấy danh sách lời mời và yêu cầu tham gia thành công',
    data: { requests: requests as unknown as WorkspaceRequestItem[], inviteCount, joinCount }
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

export const cancelJoinRequestController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId } = req.params
  const { user_id } = req.decode_authorization as TokenPayload

  if (!workspaceId || !user_id) {
    throw new ErrorWithStatus({
      message: 'Thiếu thông tin workspaceId hoặc userId',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const result = await workspaceServices.cancelJoinRequest(BigInt(workspaceId as string), BigInt(user_id))

  const response: ApiResponse<{ workspaceMember: WorkspaceMember }> = {
    message: 'Hủy yêu cầu tham gia workspace thành công',
    data: { workspaceMember: result as unknown as WorkspaceMember }
  }

  res.json(response)
}
