import { z } from 'zod'

// Schema cho việc tạo user
export const registerSchema = z.object({
  email: z.string().email('Email không hợp lệ'),
  password: z.string().min(6, 'Mật khẩu phải có ít nhất 6 ký tự'),
  username: z.string().min(3, 'Username phải có ít nhất 3 ký tự')
})

// Schema cho việc cập nhật user
export const updateUserSchema = z.object({
  avatar: z.string().max(500, 'Avatar không được quá 500 ký tự').optional().or(z.literal('')),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  fullName: z.string().max(100, 'Full name không được quá 100 ký tự').optional(),
  bio: z.string().max(500, 'Bio không được quá 500 ký tự').optional(),
  phone: z
    .string()
    .regex(/^[0-9+\-\s()]{6,20}$/, 'Số điện thoại không hợp lệ')
    .optional()
    .or(z.literal('')),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày sinh phải có định dạng YYYY-MM-DD')
    .refine((v) => !isNaN(Date.parse(v)), 'Ngày sinh không hợp lệ')
    .optional()
})

// Schema cho việc đăng nhập
export const loginSchema = z.object({
  email: z.string().email('Email không hợp lệ'),
  password: z.string().min(1, 'Mật khẩu không được để trống')
})

// Schema cho việc đổi mật khẩu
export const changePasswordSchema = z
  .object({
    oldPassword: z.string().min(6, 'Mật khẩu cũ không được để trống'),
    newPassword: z.string().min(6, 'Mật khẩu mới phải có ít nhất 6 ký tự'),
    confirmNewPassword: z.string().min(6, 'Mật khẩu xác nhận không được để trống')
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: 'Mật khẩu xác nhận không khớp',
    path: ['confirmNewPassword']
  })
  .refine((data) => data.oldPassword !== data.newPassword, {
    message: 'Mật khẩu mới phải khác mật khẩu cũ',
    path: ['newPassword']
  })

// Schema cho việc tìm kiếm
export const searchUserSchema = z.object({
  q: z.string().min(1, 'Từ khóa tìm kiếm không được để trống')
})

// Schema cho việc cập nhật trạng thái
export const updateStatusSchema = z.object({
  status: z.enum(['ONLINE', 'OFFLINE', 'AWAY', 'BUSY'])
})

// Type inference từ schema
export type RegisterBody = z.infer<typeof registerSchema>
export type UpdateUserBody = z.infer<typeof updateUserSchema>
export type LoginBody = z.infer<typeof loginSchema>
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>
export type SearchUserQuery = z.infer<typeof searchUserSchema>
export type UpdateStatusBody = z.infer<typeof updateStatusSchema>
