import { User } from '~/models/responses/user.responses'

export interface Message {
  id: string
  channelId: string
  senderId: string
  content: string
  messageType: string
  replyToId: string
  createdAt: string
  updatedAt: string
  deletedAt: User
  sender: User
}
