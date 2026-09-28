import { Request, Response } from 'express'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { ApiResponse, TokenPayload } from '~/models/responses/user.responses'
import {
  InviteLinkData,
  InviteSearchUserItem,
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
  const { user_id } = req.decode_authorization as TokenPayload
  const workspaces = await workspaceServices.getWorkSpaceDetail(BigInt(workspaceId as string), BigInt(user_id))

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
  const { search, page, limit } = req.query as {
    search: string
    page: string
    limit: string
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

// dành cho user
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

// dành cho user
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

export const searchUsersToInviteController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId } = req.params
  const { user_id } = req.decode_authorization as TokenPayload
  const { search, page, limit } = req.query as {
    search: string
    page: string
    limit: string
  }

  if (!workspaceId || !user_id) {
    throw new ErrorWithStatus({
      message: 'Thiếu thông tin workspaceId hoặc userId',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const result = await workspaceServices.searchUsersToInvite({
    workspaceId: BigInt(workspaceId as string),
    currentUserId: user_id,
    searchTerm: search ?? '',
    page: Number(page) || 1,
    limit: Number(limit) || 20
  })

  const response: ApiResponse<{
    items: InviteSearchUserItem[]
    total: number
    page: number
    limit: number
    totalPages: number
  }> = {
    message: 'Lấy danh sách user để mời vào workspace thành công',
    data: {
      items: result.items as unknown as InviteSearchUserItem[],
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages
    }
  }

  res.json(response)
}

// dành cho admin/owner
export const inviteUserToWorkspaceController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId } = req.params
  const { user_id: inviterId } = req.decode_authorization as TokenPayload
  const { userId: inviteeIdRaw } = req.body as { userId: string }

  const result = await workspaceServices.inviteUserToWorkspace(
    BigInt(workspaceId as string),
    BigInt(inviterId),
    BigInt(inviteeIdRaw)
  )

  const response: ApiResponse<{ workspaceMember: WorkspaceMember }> = {
    message: 'Gửi lời mời tham gia workspace thành công',
    data: { workspaceMember: result as unknown as WorkspaceMember }
  }

  res.json(response)
}

// dành cho admin/owner
export const cancelInviteController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId } = req.params
  const { user_id: inviterId } = req.decode_authorization as TokenPayload
  const { userId: inviteeIdRaw } = req.body as { userId: string }

  const result = await workspaceServices.cancelInvite(
    BigInt(workspaceId as string),
    BigInt(inviterId),
    BigInt(inviteeIdRaw)
  )

  const response: ApiResponse<{ workspaceMember: WorkspaceMember }> = {
    message: 'Hủy lời mời tham gia workspace thành công',
    data: { workspaceMember: result as unknown as WorkspaceMember }
  }

  res.json(response)
}

export const getActiveInviteLinkController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId } = req.params

  const data = await workspaceServices.getActiveInviteLink(BigInt(workspaceId as string))

  const response: ApiResponse<InviteLinkData> = {
    message: data ? 'OK' : 'Workspace chưa có link mời đang hoạt động',
    data: data
  }

  res.json(response)
}

export const createInviteLinkController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId } = req.params
  const { user_id } = req.decode_authorization as TokenPayload
  const { ttlSeconds } = req.body as { ttlSeconds?: number | null }

  if (!workspaceId || !user_id) {
    throw new ErrorWithStatus({
      message: 'Thiếu thông tin workspaceId hoặc userId',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const invite = await workspaceServices.createInviteLink(BigInt(workspaceId as string), BigInt(user_id), ttlSeconds)

  const response: ApiResponse<{
    code: string
    url: string
    expiresAt: string | null
    createdAt: string
  }> = {
    message: 'Tạo link mời thành công',
    data: {
      code: invite.code,
      url: `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/invite/${invite.code}`,
      expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
      createdAt: invite.createdAt.toISOString()
    }
  }

  res.json(response)
}

export const revokeInviteLinkController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId, code } = req.params
  const { user_id } = req.decode_authorization as TokenPayload

  if (!workspaceId || !code || !user_id) {
    throw new ErrorWithStatus({
      message: 'Thiếu thông tin workspaceId, code hoặc userId',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const codeRaw = Array.isArray(code) ? code[0] : code
  if (!codeRaw) {
    throw new ErrorWithStatus({
      message: 'Thiếu code',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const invite = await workspaceServices.revokeInviteLink(BigInt(workspaceId as string), codeRaw, BigInt(user_id))

  const response: ApiResponse<{ code: string; status: string; revokedAt: string | null }> = {
    message: 'Thu hồi link thành công',
    data: {
      code: invite.code,
      status: invite.status,
      revokedAt: invite.revokedAt ? invite.revokedAt.toISOString() : null
    }
  }

  res.json(response)
}
