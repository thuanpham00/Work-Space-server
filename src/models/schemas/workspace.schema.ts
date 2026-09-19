import { z } from 'zod'

export const getWorkspaceMembersSchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
})

export type GetWorkspaceMembersQuery = z.infer<typeof getWorkspaceMembersSchema>
