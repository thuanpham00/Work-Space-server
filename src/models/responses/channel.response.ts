import { ChannelMemberRole } from '~/constants/enum'
import { User } from '~/models/responses/user.responses'

export enum ChannelType {
  TEXT = 'TEXT',
  VOICE = 'VOICE',
  DM = 'DM'
}

export interface Channel {
  id: string
  workspaceId: string | null
  categoryId: string | null
  name: string | null
  description: string | null
  type: string | null
  isPrivate: boolean
  isDefault: boolean
  createdAt: string
  updatedAt: string
  members?: ChannelMember[]
  role?: ChannelMemberRole
}

export interface ChannelConfig {
  id: string
  channelId: string
  backgroundUrl: string
  backgroundColor: string
  accent: string
  createdAt: string
  updatedAt: string
}

export interface ChannelMemberNickname {
  id: string
  channelId: string
  userId: string
  user: User
  nickname: string
  updatedAt: string
}

export enum ChannelInviteStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED'
}

export interface ChannelRequestItem {
  userId: string
  username: string
  avatar: string | null
  fullName: string | null
  role: ChannelMemberRole
  type: 'invite' | 'join'
  invitedById: string | null
  invitedByName: string | null
  requestedById: string | null
  invitedAt: string | null
  joinedAt: string | null
}

export interface ChannelMember {
  userId: string
  username: string
  avatar: string
  fullName: string
  role: ChannelMemberRole
}
