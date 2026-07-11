import { NextFunction, Request, Response } from 'express'
import { ParamsDictionary } from 'express-serve-static-core'
import { JsonWebTokenError } from 'jsonwebtoken'
import httpStatus from '~/constants/httpStatus'
import { envConfig } from '~/utils/config'
import { ErrorWithStatus } from '~/constants/errors'
import databaseServices from '~/services/database.services'
import { verifyToken } from '~/utils/jwt'

export const accessTokenValidator = async (
  req: Request<ParamsDictionary, any, any>,
  res: Response,
  next: NextFunction
) => {
  const { authorization } = req.headers
  const access_token = ((authorization as string) || '').split(' ')[1]
  if (!access_token) {
    throw new ErrorWithStatus({
      message: 'AccessToken bắt buộc!',
      status: httpStatus.UNAUTHORIZED
    })
  }
  try {
    const decode_authorization = await verifyToken({
      token: access_token,
      privateKey: envConfig.secret_key_access_token
    })
    req.decode_authorization = decode_authorization
    next()
  } catch (error) {
    if (error instanceof JsonWebTokenError) {
      throw new ErrorWithStatus({
        message: 'AccessToken đã hết hạn!',
        status: httpStatus.UNAUTHORIZED
      })
    }
    throw error
  }
}

export const refreshTokenValidator = async (req: Request, res: Response, next: NextFunction) => {
  const { refresh_token } = req.cookies
  if (!refresh_token) {
    throw new ErrorWithStatus({
      message: 'RefreshToken bắt buộc!',
      status: httpStatus.UNAUTHORIZED
    })
  }
  try {
    const [decode_refreshToken, findToken] = await Promise.all([
      verifyToken({ token: refresh_token, privateKey: envConfig.secret_key_refresh_token }),
      databaseServices.prisma.refreshToken.findUnique({ where: { token: refresh_token } })
    ])
    req.decode_refreshToken = decode_refreshToken
    if (findToken === null) {
      throw new ErrorWithStatus({
        message: 'RefreshToken đã được sử dụng hoặc không tồn tại!',
        status: httpStatus.UNAUTHORIZED
      })
    }
    next()
  } catch (error) {
    if (error instanceof JsonWebTokenError) {
      throw new ErrorWithStatus({
        message: 'RefreshToken đã hết hạn!',
        status: httpStatus.UNAUTHORIZED
      })
    }
    throw error
  }
}
