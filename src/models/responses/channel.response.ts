export interface ChannelDM {
  id: string
  workspaceId: any
  name: string
  description: string
  type: string
  isPrivate: boolean
  createdAt: string
  friend: {
    id: string
    email: string
    password: string
    username: string
    displayName: string
    avatar: any
    bio: any
    status: string
    createdAt: string
    updatedAt: string
    dateOfBirth: string
    phone: string
    gender: string
    fullName: string
  }
}
