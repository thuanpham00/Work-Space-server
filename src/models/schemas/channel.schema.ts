import { z } from 'zod'

export const createChannelSchema = z
  .object({
    categoryId: z.string().min(1, 'ID category không được để trống'),
    name: z.string().trim().min(1, 'Tên channel không được để trống').max(100, 'Tên channel không được quá 100 ký tự'),
    type: z.string().min(1, 'Type không được để trống'),
    description: z.string().trim().max(500, 'Mô tả không được quá 500 ký tự').optional().nullable(),
    isPrivate: z.boolean().optional().default(false),
    isDefault: z.boolean().optional().default(false)
  })
  .superRefine((data, ctx) => {
    // Validation: Nếu isPrivate = true thì isDefault phải = false
    if (data.isPrivate === true && data.isDefault === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Channel private không thể là channel mặc định (isDefault phải là false)',
        path: ['isDefault']
      })
    }
  })

export type CreateChannelBody = z.infer<typeof createChannelSchema>

export const updateChannelConfigSchema = z.object({
  backgroundColor: z.string().optional(),
  backgroundImage: z.string().optional(),
  accentColor: z.string().optional()
})

export const updateChannelNicknameSchema = z.object({
  nickname: z.object({
    userId: z.string().min(1, 'ID user không được để trống'),
    nickname: z.string().trim().min(1, 'Nickname không được để trống').max(100, 'Nickname không được quá 100 ký tự')
  })
})
