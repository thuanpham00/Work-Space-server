import { z } from 'zod'

export const createChannelSchema = z.object({
  categoryId: z.string().min(1, 'ID category không được để trống'),
  name: z.string().trim().min(1, 'Tên channel không được để trống').max(100, 'Tên channel không được quá 100 ký tự'),
  type: z.string().min(1, 'Type không được để trống'),
  description: z.string().trim().max(500, 'Mô tả không được quá 500 ký tự').optional().nullable(),
  isPrivate: z.boolean().optional().default(false)
})

export type CreateChannelBody = z.infer<typeof createChannelSchema>

