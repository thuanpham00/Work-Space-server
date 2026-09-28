import { z } from 'zod'

export const workspaceInviteCodeParamSchema = z.object({
  code: z.string().min(1).max(64)
})

export type WorkspaceInviteCodeParam = z.infer<typeof workspaceInviteCodeParamSchema>
