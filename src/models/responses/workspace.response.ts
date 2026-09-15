import { Channel } from '~/models/responses/channel.response'

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
