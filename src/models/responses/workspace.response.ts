import { Channel } from '~/models/responses/channel.response'
import { WorkspaceMemberRole } from '~/constants/enum'

export interface WorkspaceMemberItem {
  id: string
  username: string
  displayName: string
  avatar: string | null
  fullName: string | null
  role: WorkspaceMemberRole
  joinedAt: string | null
}

export interface PaginatedMembers {
  members: WorkspaceMemberItem[]
  total: number
  page: number
  limit: number
  total_page: number
}

export interface WorkspaceRequestItem {
  userId: string
  username: string
  avatar: string | null
  fullName: string | null
  role: WorkspaceMemberRole
  type: 'invite' | 'join'
  invitedById: string | null
  invitedByName: string | null
  requestedById: string | null
  invitedAt: string | null
  joinedAt: string | null
}

export interface WorkspaceRequestsResponse {
  requests: WorkspaceRequestItem[]
  inviteCount: number
  joinCount: number
}

export interface WorkspaceCategory {
  id: string
  workspaceId: string
  name: string | null
  position: number
  createdAt: string
  updatedAt: string
  channels?: Channel[]
}

export interface Workspace {
  id: string
  name: string | null
  description: string | null
  avatar: string | null
  ownerId: string | null
  createdAt: string
  updatedAt: string
  role?: WorkspaceMemberRole
  categories?: WorkspaceCategory[]
}

export enum WorkspaceMemberStatus {
  ACTIVE = 'ACTIVE',
  PENDING_INVITE = 'PENDING_INVITE',
  PENDING_REQUEST = 'PENDING_REQUEST',
  REJECTED = 'REJECTED',
  LEFT = 'LEFT',
  CANCELLED = 'CANCELLED'
}

export interface WorkspaceMember {
  workspaceId: string
  userId: string
  role: string
  status: WorkspaceMemberStatus
  joinedAt: string | null
  invitedAt: string | null
  acceptedAt: string | null
  rejectedAt: string | null
  invitedById: string | null
  requestedById: string
  approvedById: string | null
  approvedByType: string | null
}

export type InviteDenialReason =
  | 'OK'
  | 'ALREADY_MEMBER'
  | 'ALREADY_PENDING_INVITE'
  | 'ALREADY_PENDING_REQUEST'
  | 'FRIENDS_ONLY_POLICY'
  | 'NO_FRIEND_REQUEST'

export interface InviteSearchUserItem {
  id: string
  username: string | null
  displayName: string | null
  fullName: string | null
  avatar: string | null
  friendStatus: string | null
  workspaceInvitePolicy: 'EVERYONE' | 'FRIENDS_ONLY' | null
  existingWorkspaceStatus: WorkspaceMemberStatus | null
  canInvite: boolean
  reason: InviteDenialReason
}

export interface PaginatedInviteSearch {
  items: InviteSearchUserItem[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface InviteLinkData {
  url: string
  expiresAt: string | null
}

export interface RevokeInviteLinkResponse {
  code: string
  status: string
  revokedAt: string | null
}
