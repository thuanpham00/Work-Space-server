import { signToken, verifyToken } from '~/utils/jwt'
import databaseServices from './database.services'
import { TokenType } from '~/constants/enum'
import { envConfig } from '~/utils/config'
import { hashPassword } from '~/utils/scripto'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'

class UserService {
  private signAccessToken({ user_id }: { user_id: string }) {
    return signToken({
      payload: {
        user_id,
        tokenType: TokenType.AccessToken
      },
      privateKey: envConfig.secret_key_access_token,
      options: {
        expiresIn: envConfig.expire_in_access_token as string
      }
    })
  }

  private signRefreshToken({ user_id, exp }: { user_id: string; exp?: number }) {
    if (exp) {
      return signToken({
        payload: {
          user_id,
          tokenType: TokenType.RefreshToken,
          exp: exp
        },
        privateKey: envConfig.secret_key_refresh_token
      })
    }
    return signToken({
      payload: {
        user_id,
        tokenType: TokenType.RefreshToken
      },
      privateKey: envConfig.secret_key_refresh_token,
      options: {
        expiresIn: envConfig.expire_in_refresh_token as string
      }
    })
  }

  signAccessTokenAndRefreshToken({ user_id }: { user_id: string }) {
    return Promise.all([this.signAccessToken({ user_id }), this.signRefreshToken({ user_id })])
  }

  decodeRefreshToken(refreshToken: string) {
    return verifyToken({ token: refreshToken, privateKey: envConfig.secret_key_refresh_token })
  }

  async register(payload: { email: string; password: string; username?: string }) {
    const newUser = await databaseServices.prisma.user.create({
      data: {
        email: payload.email,
        password: hashPassword(payload.password),
        username: payload.username,
        displayName: payload.username
      }
    })

    return {
      user: {
        ...newUser,
        id: newUser.id.toString()
      }
    }
  }

  async login({ email, password }: { email: string; password: string }) {
    console.log(envConfig.expire_in_access_token)
    const user = await databaseServices.prisma.user.findUnique({
      where: { email, password: hashPassword(password) }
    })

    if (!user) {
      throw new ErrorWithStatus({
        message: 'Email hoặc mật khẩu không chính xác',
        status: httpStatus.BAD_REQUESTED
      })
    }

    const [accessToken, refreshToken] = await this.signAccessTokenAndRefreshToken({ user_id: user.id.toString() })
    const { exp, iat } = await this.decodeRefreshToken(refreshToken)

    await databaseServices.prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId: user.id,
        exp: exp,
        iat: iat
      }
    })

    return {
      accessToken,
      refreshToken,
      user: {
        ...user,
        id: user.id.toString()
      }
    }
  }

  async logout({ user_id, refresh_token }: { user_id: string; refresh_token: string }) {
    await databaseServices.prisma.refreshToken.delete({
      where: {
        userId: BigInt(user_id),
        token: refresh_token
      }
    })
    return {
      message: 'Logout thành công'
    }
  }

  async refreshToken({ token, user_id, exp }: { token: string; user_id: string; exp: number }) {
    const [accessToken, refreshTokenNew] = await Promise.all([
      this.signAccessToken({ user_id }),
      this.signRefreshToken({ user_id, exp }),
      databaseServices.prisma.refreshToken.delete({
        where: {
          userId: BigInt(user_id),
          token: token
        }
      })
    ])

    const decodeRefreshToken = await this.decodeRefreshToken(refreshTokenNew)

    await databaseServices.prisma.refreshToken.create({
      data: {
        token: refreshTokenNew,
        userId: BigInt(user_id),
        exp: decodeRefreshToken.exp,
        iat: decodeRefreshToken.iat
      }
    })

    return {
      accessToken,
      refreshToken: refreshTokenNew
    }
  }

  // Lấy tất cả users
  async getAllUsers() {
    const users = await databaseServices.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatar: true,
        status: true,
        createdAt: true
      }
    })
    return users.map((user) => ({
      ...user,
      id: user.id.toString()
    }))
  }

  // Lấy user theo id
  async getUserById(id: bigint) {
    const user = await databaseServices.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatar: true,
        bio: true,
        status: true,
        createdAt: true,
        fullName: true,
        gender: true,
        phone: true,
        dateOfBirth: true,
      }
    })
    if (user) {
      return { ...user, id: user.id.toString() }
    }
    return user
  }

  // Lấy user theo email
  async getUserByEmail(email: string) {
    return await databaseServices.prisma.user.findUnique({
      where: { email }
    })
  }

  // Lấy user theo email
  async getUserByUsername(username: string) {
    console.log(username)
    const user = await databaseServices.prisma.user.findUnique({
      where: { username }
    })
    console.log(user)
    return user
  }

  // Cập nhật user
  async updateUser(
    id: bigint,
    payload: Partial<{
      username: string
      displayName: string
      avatar: string
      fullName: string
      gender: 'MALE' | 'FEMALE' | 'OTHER'
      bio: string
      phone: string
      dateOfBirth: string
    }>
  ) {
    if (payload.username) {
      const existing = await databaseServices.prisma.user.findUnique({
        where: { username: payload.username }
      })
      if (existing && existing.id !== id) {
        throw new ErrorWithStatus({
          message: 'Username đã được sử dụng',
          status: httpStatus.BAD_REQUESTED
        })
      }
    }

    const data: any = {}
    if (payload.username !== undefined) data.username = payload.username
    if (payload.displayName !== undefined) data.displayName = payload.displayName
    if (payload.avatar !== undefined) data.avatar = payload.avatar === '' ? null : payload.avatar
    if (payload.bio !== undefined) data.bio = payload.bio
    if (payload.phone !== undefined) data.phone = payload.phone === '' ? null : payload.phone
    if (payload.dateOfBirth !== undefined) data.dateOfBirth = payload.dateOfBirth
    if (payload.fullName !== undefined) data.fullName = payload.fullName
    if (payload.gender !== undefined) data.gender = payload.gender

    const user = await databaseServices.prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        fullName: true,
        avatar: true,
        bio: true,
        phone: true,
        dateOfBirth: true,
        gender: true,
        status: true,
        createdAt: true
      }
    })

    return { ...user, id: user.id.toString() }
  }

  // Cập nhật trạng thái online/offline
  async updateUserStatus(id: bigint, status: 'ONLINE' | 'OFFLINE' | 'AWAY' | 'BUSY') {
    return await databaseServices.prisma.user.update({
      where: { id },
      data: { status }
    })
  }

  // Đổi mật khẩu
  async changePassword(userId: bigint, oldPassword: string, newPassword: string) {
    const user = await databaseServices.prisma.user.findUnique({
      where: { id: userId }
    })

    if (!user) {
      throw new ErrorWithStatus({
        message: 'User không tồn tại',
        status: httpStatus.NOTFOUND
      })
    }

    if (user.password !== hashPassword(oldPassword)) {
      throw new ErrorWithStatus({
        message: 'Mật khẩu cũ không chính xác',
        status: httpStatus.BAD_REQUESTED
      })
    }

    await databaseServices.prisma.user.update({
      where: { id: userId },
      data: { password: hashPassword(newPassword) }
    })

    return {
      message: 'Đổi mật khẩu thành công'
    }
  }
}

export default new UserService()
