/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request, Response } from 'express'
import fs from 'fs'
import userService from '../services/user.services'
import r2Service from '~/services/r2.services'
import {
  UpdateUserBody,
  UpdateStatusBody,
  RegisterBody,
  LoginBody,
  ChangePasswordBody
} from '../models/schemas/user.schemas'
import { AuthenticatedRequest, GetAllUsersQueryParams } from '../models/requests/user.requests'
import { ApiResponse, AuthResponse, TokenPayload, User } from '~/models/responses/user.responses'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { getUploadedFile } from '~/middlewares/upload.middlewares'
import { ParamsDictionary } from 'express-serve-static-core'

export const registerController = async (req: Request, res: Response) => {
  const body = req.body as RegisterBody

  const existingEmail = await userService.getUserByEmail(body.email)
  const existingUsername = await userService.getUserByUsername(body.username)
  if (existingEmail) {
    throw new ErrorWithStatus({
      message: 'Email đã được sử dụng',
      status: httpStatus.BAD_REQUESTED
    })
  }
  if (existingUsername) {
    throw new ErrorWithStatus({
      message: 'Username đã được sử dụng',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const { user } = await userService.register(body)

  const response: ApiResponse<User> = {
    message: 'Đăng ký thành công',
    data: user as unknown as User
  }

  res.status(201).json(response)
}

export const loginController = async (req: Request, res: Response) => {
  const body = req.body as LoginBody

  const existingUser = await userService.getUserByEmail(body.email)
  if (!existingUser) {
    throw new ErrorWithStatus({
      message: 'Email không tồn tại',
      status: httpStatus.NOTFOUND
    })
  }

  const { accessToken, refreshToken, user: userInfo } = await userService.login(body)

  res.cookie('refresh_token', refreshToken, {
    httpOnly: true, // chặn client javascript không thể truy cập
    // secure: true, // chỉ cho phép cookie gửi qua kết nối HTTPS
    sameSite: 'lax',
    maxAge: 100 * 24 * 60 * 60 * 1000, // Đồng bộ thời gian sống cookie (100 ngày)
    path: '/'
  })

  const response: ApiResponse<AuthResponse> = {
    message: 'Đăng nhập thành công',
    data: {
      access_token: accessToken,
      user: userInfo as unknown as User
    }
  }

  res.status(200).json(response)
}

export const logoutController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload
  const refresh_token = req.cookies.refresh_token // lấy cookie từ server
  const result = await userService.logout({ user_id, refresh_token })

  res.clearCookie('refresh_token', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/'
  })

  res.json({
    message: result.message
  })
}

export const refreshTokenController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id, exp } = req.decode_refreshToken as TokenPayload
  const { refresh_token } = req.cookies

  const { accessToken, refreshToken: refresh_token_new } = await userService.refreshToken({
    token: refresh_token,
    user_id: user_id,
    exp: exp
  })

  res.cookie('refresh_token', refresh_token_new, {
    httpOnly: true,
    // secure: true,
    sameSite: 'lax',
    maxAge: 100 * 24 * 60 * 60 * 1000, // Đồng bộ thời gian sống cookie (100 ngày)
    path: '/'
  })

  res.json({
    message: 'Refresh token thành công',
    data: {
      access_token: accessToken
    }
  })
}

export const getMeController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload
  const user = await userService.getUserById(BigInt(user_id))

  const response: ApiResponse<{ user: User }> = {
    message: 'Lấy thông tin user thành công',
    data: {
      user: user as unknown as User
    }
  }

  res.json(response)
}

export const getAllUsers = async (req: Request<ParamsDictionary, any, any, GetAllUsersQueryParams>, res: Response) => {
  const { page, limit, search } = req.query
  const { user_id: me_id } = req.decode_authorization as TokenPayload
  const users = await userService.getAllUsers(page as string, limit as string, search as string, me_id as string)

  const response: ApiResponse<{ users: User[]; total: number }> = {
    message: 'Lấy danh sách users thành công',
    data: {
      users: users as unknown as User[],
      total: users.length
    }
  }

  res.json(response)
}

export const updateUser = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload
  const body = req.body as UpdateUserBody

  const user = await userService.updateUser(BigInt(user_id as string), body)

  const response: ApiResponse<User> = {
    message: 'Cập nhật user thành công',
    data: user as unknown as User
  }

  res.json(response)
}

export const updateStatus = async (req: AuthenticatedRequest, res: Response) => {
  const { userId } = req.params
  const { status } = req.body as UpdateStatusBody

  const currentUserId = req.decode_authorization.user_id
  if (currentUserId !== userId) {
    throw new ErrorWithStatus({
      message: 'Bạn không có quyền cập nhật trạng thái của user này',
      status: httpStatus.FORBIDDEN
    })
  }

  const user = await userService.updateUserStatus(BigInt(userId as string), status)

  const response: ApiResponse<User> = {
    message: 'Cập nhật trạng thái thành công',
    data: user as unknown as User
  }

  res.json(response)
}

export const uploadImageController = async (req: AuthenticatedRequest, res: Response) => {
  const imageFile = getUploadedFile(req, 'avatar')

  const buffer = fs.readFileSync(imageFile.filepath)
  const userId = (req.decode_authorization as TokenPayload).user_id

  const result = await r2Service.uploadImage(buffer, userId)

  const response: ApiResponse<typeof result> = {
    message: 'Upload ảnh thành công',
    data: result
  }

  res.status(httpStatus.CREATED).json(response)
}

export const changePasswordController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload
  const { oldPassword, newPassword } = req.body as ChangePasswordBody

  const result = await userService.changePassword(BigInt(user_id), oldPassword, newPassword)

  res.json({
    message: result.message
  })
}

// lấy thông tin user và trạng thái friend của user đó với user hiện tại
export const getUserStatusController = async (req: Request, res: Response) => {
  const { userId: addressId } = req.params
  const { user_id: requestId } = req.decode_authorization as TokenPayload

  if (!addressId || !requestId) {
    throw new ErrorWithStatus({
      message: 'Thiếu thông tin userId hoặc user_id',
      status: httpStatus.BAD_REQUESTED
    })
  }

  if (addressId === requestId) {
    throw new ErrorWithStatus({
      message: 'Không thể lấy thông tin trạng thái của chính mình',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const user = await userService.getInfoUserStatus(BigInt(addressId as string), BigInt(requestId))

  if (!user) {
    throw new ErrorWithStatus({
      message: 'User không tồn tại',
      status: httpStatus.NOTFOUND
    })
  }

  const response: ApiResponse<{ user: User }> = {
    message: 'Lấy thông tin user thành công',
    data: { user: user as unknown as User }
  }

  res.json(response)
}
