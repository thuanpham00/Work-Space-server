import { z } from 'zod'

export const channelInviteCodeParamSchema = z.object({
  code: z.string().min(1).max(64)
})

export type ChannelInviteCodeParam = z.infer<typeof channelInviteCodeParamSchema>
