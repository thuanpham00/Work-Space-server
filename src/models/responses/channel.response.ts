import { User } from '~/models/responses/user.responses'

export interface Channel {
  id: string
  workspaceId: string | null
  categoryId: string | null
  name: string | null
  description: string | null
  type: string | null
  isPrivate: boolean
  createdAt: string
  updatedAt: string
  members?: MemberChannel[]
}

export interface MemberChannel {
  joinedAt: string
  userId: string
  email: string
  username: string
  displayName: string
  avatar: string
  status: string
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
