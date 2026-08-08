import { z } from 'zod'

export const categoryChannelIdSchema = z.object({
  categoryId: z.string().min(1, 'ID category không được để trống')
})

export const workspaceIdSchema = z.object({
  workspaceId: z.string().min(1, 'ID workspace không được để trống')
})

export const createCategoryChannelSchema = z.object({
  workspaceId: z.string().min(1, 'ID workspace không được để trống'),
  name: z.string().trim().min(1, 'Tên category không được để trống').max(100, 'Tên category không được quá 100 ký tự')
})

export const updateCategoryChannelSchema = z.object({
  workspaceId: z.string().min(1, 'ID workspace không được để trống'),
  name: z
    .string()
    .trim()
    .min(1, 'Tên category không được để trống')
    .max(100, 'Tên category không được quá 100 ký tự')
    .optional()
})

export const deleteCategoryChannelSchema = z.object({
  workspaceId: z.string().min(1, 'ID workspace không được để trống')
})

export type CategoryChannelIdParams = z.infer<typeof categoryChannelIdSchema>
export type WorkspaceIdParams = z.infer<typeof workspaceIdSchema>
export type CreateCategoryChannelBody = z.infer<typeof createCategoryChannelSchema>
export type UpdateCategoryChannelBody = z.infer<typeof updateCategoryChannelSchema>
export type DeleteCategoryChannelBody = z.infer<typeof deleteCategoryChannelSchema>
