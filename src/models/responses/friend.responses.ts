export interface FriendResponse {
  id: string
  username: string
  displayName: string
  avatar: null
  fullName: string
  createdAt: string
}

export interface FriendStatusCountResponse {
  sent: number
  received: number
  accepted: number
}

export interface FriendDMChannelResponse {
  id: string
  channelId: string
  name: string | null
  description: string | null
  type: string | null
  isPrivate: boolean
  createdAt: string
  updatedAt: string
  friend: {
    id: string
    username: string
    displayName: string
    avatar: string | null
    fullName: string
    createdAt: string
  } | null
  lastMessage: {
    id: string
    channelId: string
    senderId: string
    content: string | null
    messageType: string
    replyToId: string | null
    createdAt: string
    updatedAt: string
    deletedAt: string | null
    sender: {
      id: string
      username: string
      displayName: string
      avatar: string | null
      fullName: string
    }
  } | null
}
