import { Channel } from '~/models/responses/channel.response'

export interface Workspace {
  id: string
  name: string | null
  description: string | null
  avatar: string | null
  ownerId: string | null
  createdAt: string
  updatedAt: string
  channels?: Channel[]
}
