/* eslint-disable @typescript-eslint/no-explicit-any */
import { signToken, verifyToken } from '~/utils/jwt'
import databaseServices from './database.services'
import { ChannelType, FriendStatus, FriendStatusRequest, TokenType, WorkspaceMemberRole } from '~/constants/enum'
import { envConfig } from '~/utils/config'
import { hashPassword } from '~/utils/scripto'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { UpdateUserBody } from '~/models/schemas/user.schemas'

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

    // tạo workspace mặc định cho user mới đăng ký
    await this.createWorkspaceForUser(newUser.id)

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

  async createWorkspaceForUser(userId: bigint) {
    // khi user đăng ký tài khoản khởi tạo 1 workspace mặc định cho user đó và 2 channel thuộc workspace đó là general (1 kênh text và 1 kênh voice)
    await databaseServices.prisma.workspace.create({
      data: {
        name: 'Workspace mặc định',
        description: 'Workspace mặc định được tạo khi đăng ký tài khoản',
        ownerId: userId,
        channels: {
          create: [
            {
              name: 'general',
              description: 'Kênh chung',
              type: ChannelType.TEXT,
              isPrivate: false,
              members: {
                create: [
                  {
                    userId: userId,
                    joinedAt: new Date()
                  }
                ]
              }
            },
            {
              name: 'voice',
              description: 'Kênh thoại',
              type: ChannelType.VOICE,
              isPrivate: false,
              members: {
                create: [
                  {
                    userId: userId,
                    joinedAt: new Date()
                  }
                ]
              }
            }
          ]
        },
        members: {
          create: [
            {
              userId: userId,
              role: WorkspaceMemberRole.OWNER,
              joinedAt: new Date()
            }
          ]
        }
      },
      include: {
        channels: true
      }
    })
  }

  async getAllUsers(page: string, limit: string, search: string, me_id: string) {
    const pageNumber = Number(page) || 1
    const limitNumber = Number(limit) + 1 || 10
    const skip = (pageNumber - 1) * limitNumber
    const where: any = {}
    if (search) {
      where.OR = [
        { username: { contains: search } },
        { displayName: { contains: search } },
        { fullName: { contains: search } }
      ]
    }
    const users = await databaseServices.prisma.user.findMany({
      where,
      skip,
      take: limitNumber,
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatar: true,
        status: true,
        createdAt: true,
        fullName: true,
        phone: true,
        bio: true,
        dateOfBirth: true,
        gender: true
      }
    })
    return users
      .filter((user) => user.id !== BigInt(me_id))
      .map((user) => ({
        ...user,
        id: user.id.toString()
      }))
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
        status: true,
        createdAt: true,
        fullName: true,
        gender: true,
        phone: true,
        dateOfBirth: true,
        privacySettings: true
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
        status: true,
        createdAt: true
      }
    })

    return { ...user, id: user.id.toString() }
  }

  async updateUserStatus(id: bigint, status: 'ONLINE' | 'OFFLINE' | 'AWAY' | 'BUSY') {
    return await databaseServices.prisma.user.update({
      where: { id },
      data: { status }
    })
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

  async getWorkspacesOfUser(userId: bigint) {
    // đầu tiên lấy workspace mặc định của user trước và sau đó check xem user có là thành viên của workspace nào khác không
    const workspaces = await databaseServices.prisma.workspace.findMany({
      where: {
        OR: [{ ownerId: userId }, { members: { some: { userId } } }]
      }
    })

    return workspaces.map((workspace) => ({
      ...workspace,
      id: workspace.id.toString(),
      ownerId: workspace.ownerId ? workspace.ownerId.toString() : null
    }))
  }

  // Lấy thông tin user và trạng thái kết bạn giữa user hiện tại và user được yêu cầu
  async getInfoUserStatus(idAddress: bigint, idRequester: bigint) {
    const user = await databaseServices.prisma.user.findUnique({
      where: { id: idAddress },
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
        receivedFriendRequests: {
          where: {
            requesterId: idRequester // lấy trạng thái friend của user hiện tại với user được yêu cầu
          },
          select: {
            status: true
          },
          take: 1 // chỉ lấy 1 bản ghi vì chỉ có 1 trạng thái friend giữa 2 user
        }
      }
    })

    if (user) {
      return { ...user, id: user.id.toString() }
    }
    return user
  }
}

export default new UserService()
