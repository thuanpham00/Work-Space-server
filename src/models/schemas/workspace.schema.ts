import { z } from 'zod'

export const getWorkspaceMembersSchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
})

export type GetWorkspaceMembersQuery = z.infer<typeof getWorkspaceMembersSchema>

export const inviteSearchSchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
})

export type InviteSearchQuery = z.infer<typeof inviteSearchSchema>

export const workspaceIdParamSchema = z.object({
  workspaceId: z.coerce.bigint().positive()
})

export type WorkspaceIdParam = z.infer<typeof workspaceIdParamSchema>

export const inviteUserBodySchema = z.object({
  userId: z.coerce.bigint().positive()
})

export type InviteUserBody = z.infer<typeof inviteUserBodySchema>

export const createInviteLinkSchema = z.object({
  body: z.object({
    ttlSeconds: z.number().int().positive().nullable().optional()
  })
})

export type CreateInviteLinkBody = z.infer<typeof createInviteLinkSchema>['body']
