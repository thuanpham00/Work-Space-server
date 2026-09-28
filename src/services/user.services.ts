/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { signToken, verifyToken } from '~/utils/jwt'
import databaseServices from './database.services'
import {
  ChannelMemberRole,
  ChannelType,
  FriendStatus,
  FriendStatusRequest,
  TokenType,
  WorkspaceMemberRole
} from '~/constants/enum'
import { envConfig } from '~/utils/config'
import { hashPassword } from '~/utils/scripto'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { UpdateUserBody } from '~/models/schemas/user.schemas'
import { WorkspaceMemberStatus } from '~/models/responses/workspace.response'
import { ApproverType } from '~/generated/prisma/enums'
import workspaceServices from '~/services/workspace.services'

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
    const newUser = await databaseServices.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: payload.email,
          password: hashPassword(payload.password),
          username: payload.username,
          displayName: payload.username
        }
      })

      await tx.userSetting.create({
        data: {
          userId: user.id
        }
      })

      return user
    })

    // tạo workspace mặc định cho user mới đăng ký
    await workspaceServices.createWorkspaceForUser(newUser.id)

    return {
      user: {
        ...newUser,
        id: newUser.id.toString()
      }
    }
  }

  async login({ email, password }: { email: string; password: string }) {
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
    const existingToken = await databaseServices.prisma.refreshToken.findFirst({
      where: {
        userId: BigInt(user_id),
        token
      }
    })

    if (existingToken) {
      await databaseServices.prisma.refreshToken.deleteMany({
        where: { id: existingToken.id }
      })
    }

    const [accessToken, refreshTokenNew] = await Promise.all([
      this.signAccessToken({ user_id }),
      this.signRefreshToken({ user_id, exp })
    ])

    const decodeRefreshToken = await this.decodeRefreshToken(refreshTokenNew)

    await databaseServices.prisma.refreshToken.upsert({
      where: { token: refreshTokenNew },
      update: {
        userId: BigInt(user_id),
        exp: decodeRefreshToken.exp,
        iat: decodeRefreshToken.iat
      },
      create: {
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
        createdAt: true,
        fullName: true,
        gender: true,
        phone: true,
        dateOfBirth: true
      }
    })
    if (user) {
      return { ...user, id: user.id.toString() }
    }
    return user
  }

  async getUserByEmail(email: string) {
    return await databaseServices.prisma.user.findUnique({
      where: { email }
    })
  }

  async getUserByUsername(username: string) {
    const user = await databaseServices.prisma.user.findUnique({
      where: { username }
    })
    return user
  }

  async updateUser(id: bigint, payload: Partial<UpdateUserBody>) {
    const data: any = {}

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
        createdAt: true
      }
    })

    return { ...user, id: user.id.toString() }
  }

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

  async getInfoUserStatus(idAddress: bigint, idRequester: bigint) {
    const [user, friendship] = await Promise.all([
      databaseServices.prisma.user.findUnique({
        where: { id: idAddress },
        select: {
          id: true,
          email: true,
          username: true,
          displayName: true,
          avatar: true,
          bio: true,
          createdAt: true,
          fullName: true,
          gender: true,
          phone: true,
          dateOfBirth: true,
          setting: true
        }
      }),
      databaseServices.prisma.friend.findFirst({
        where: {
          OR: [
            { requesterId: idRequester, addresseeId: idAddress },
            { requesterId: idAddress, addresseeId: idRequester }
          ]
        },
        select: {
          status: true,
          requesterId: true
        }
      })
    ])

    if (!user) return null

    let friendStatus: FriendStatusRequest | null = null

    if (friendship) {
      if (friendship.status === FriendStatus.ACCEPTED) {
        friendStatus = FriendStatusRequest.ACCEPTED
      } else if (friendship.status === FriendStatus.PENDING) {
        friendStatus =
          friendship.requesterId === idRequester
            ? FriendStatusRequest.REQUEST_SENT
            : FriendStatusRequest.REQUEST_RECEIVED
      }
    }
    const { setting, ...rest } = user
    const response = rest

    const { showEmail, showPhone, showDateOfBirth, showGender } = user.setting ?? {}
    if (!showEmail) response.email = ''
    if (!showPhone) response.phone = ''
    if (!showDateOfBirth) response.dateOfBirth = ''
    if (!showGender) response.gender = null

    return {
      ...response,
      id: user.id.toString(),
      friendStatus
    }
  }

  async getUserSettings(userId: bigint) {
    const userSetting = await databaseServices.prisma.userSetting.findUnique({
      where: { userId }
    })
    return {
      showEmail: userSetting?.showEmail ?? true,
      showPhone: userSetting?.showPhone ?? true,
      showDateOfBirth: userSetting?.showDateOfBirth ?? true,
      showGender: userSetting?.showGender ?? true,
      workMode: userSetting?.workMode ?? 'ONLINE',
      workspaceInvitePolicy: userSetting?.workspaceInvitePolicy ?? 'EVERYONE'
    }
  }

  async updateUserSettings(
    userId: bigint,
    settings: {
      showEmail?: boolean
      showPhone?: boolean
      showDateOfBirth?: boolean
      showGender?: boolean
      workMode?: 'ONLINE' | 'OFFLINE' | 'BUSY'
      workspaceInvitePolicy?: 'EVERYONE' | 'FRIENDS_ONLY'
    }
  ) {
    const userSetting = await databaseServices.prisma.userSetting.upsert({
      where: { userId },
      create: {
        userId,
        showEmail: settings.showEmail ?? true,
        showPhone: settings.showPhone ?? true,
        showDateOfBirth: settings.showDateOfBirth ?? true,
        showGender: settings.showGender ?? true,
        workMode: settings.workMode ?? 'ONLINE',
        workspaceInvitePolicy: settings.workspaceInvitePolicy ?? 'EVERYONE'
      },
      update: {
        ...(settings.showEmail !== undefined && { showEmail: settings.showEmail }),
        ...(settings.showPhone !== undefined && { showPhone: settings.showPhone }),
        ...(settings.showDateOfBirth !== undefined && { showDateOfBirth: settings.showDateOfBirth }),
        ...(settings.showGender !== undefined && { showGender: settings.showGender }),
        ...(settings.workMode !== undefined && { workMode: settings.workMode }),
        ...(settings.workspaceInvitePolicy !== undefined && {
          workspaceInvitePolicy: settings.workspaceInvitePolicy
        })
      }
    })

    return {
      showEmail: userSetting.showEmail,
      showPhone: userSetting.showPhone,
      showDateOfBirth: userSetting.showDateOfBirth,
      showGender: userSetting.showGender,
      workMode: userSetting.workMode,
      workspaceInvitePolicy: userSetting.workspaceInvitePolicy
    }
  }
}

export default new UserService()
