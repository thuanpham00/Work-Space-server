import { z } from 'zod'

// Query cho GET /notifications
export const notificationQuerySchema = z.object({
  page: z
    .string()
    .default('1')
    .refine((v) => /^\d+$/.test(v), { message: 'Page phải là số nguyên dương' }),
  limit: z
    .string()
    .default('20')
    .refine((v) => /^\d+$/.test(v) && Number(v) <= 100, {
      message: 'Limit phải là số nguyên dương và không vượt quá 100'
    })
})

export type NotificationQuery = z.infer<typeof notificationQuerySchema>

export const notificationIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'ID notification không hợp lệ')
})

export type NotificationIdParam = z.infer<typeof notificationIdParamSchema>
