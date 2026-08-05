export interface ChannelDM {
  id: string
  workspaceId: string
  name: string
  description: string
  type: string
  isPrivate: boolean
  createdAt: string
  updatedAt: string
  friend: {
    id: string
    email: string
    password: string
    username: string
    displayName: string
    avatar: string
    bio: string
    status: string
    createdAt: string
    updatedAt: string
    dateOfBirth: string
    phone: string
    gender: string
    fullName: string
  }
}

export interface Channel {
  id: string
  workspaceId: string | null
  name: string | null
  description: string | null
  type: string | null
  isPrivate: boolean
  createdAt: string
  updatedAt: string
}
