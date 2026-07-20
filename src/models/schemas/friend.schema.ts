import { z } from 'zod'
import { FriendStatusRequest } from '~/constants/enum'

// Schema for creating a friend
export const friendSchema = z.object({
  status: z
    .enum([FriendStatusRequest.REQUEST_SENT, FriendStatusRequest.REQUEST_RECEIVED, FriendStatusRequest.ACCEPTED])
    .optional(),
  search: z.string().optional()
})
