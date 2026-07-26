import { z } from 'zod'

export const queryBase = z.object({
  page: z.string().default('1'),
  limit: z.string().default('10')
})

export type QueryBase = z.infer<typeof queryBase>
