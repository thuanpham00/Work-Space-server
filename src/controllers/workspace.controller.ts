import { Response } from 'express'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { ApiResponse, TokenPayload } from '~/models/responses/user.responses'
import { Workspace } from '~/models/responses/workspace.response'
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
