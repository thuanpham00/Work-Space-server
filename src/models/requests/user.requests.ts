import { Request } from 'express'
import { ChannelMemberRole, MemberStatus, WorkspaceMemberRole } from '~/constants/enum'
import { WorkspaceMemberStatus } from '~/constants/enum'
import { TokenPayload } from '~/models/responses/user.responses'

export interface AuthenticatedRequest extends Request {
  user: TokenPayload
  workspaceMember?: { role: WorkspaceMemberRole; status: WorkspaceMemberStatus }
  channelMember?: { role: ChannelMemberRole; status: MemberStatus }
}

export interface GetAllUsersQueryParams {
  page?: string
  limit?: string
  search?: string
  type?: 'all' | 'users' | 'workspaces'
}
