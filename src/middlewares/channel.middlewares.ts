import { NextFunction, Response } from 'express'
import { ChannelMemberRole, MemberStatus } from '~/constants/enum'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import databaseServices from '~/services/database.services'

export const channelAdminValidator = (allowedRoles: ChannelMemberRole[] = [ChannelMemberRole.ADMIN]) => {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    const channelIdRaw = req.params.channelId as string
    const { user_id } = req.decode_authorization

    if (!user_id || !channelIdRaw) {
      throw new ErrorWithStatus({
        message: 'Thiếu user_id hoặc channelId',
        status: httpStatus.BAD_REQUESTED
      })
    }

    const userId = BigInt(user_id)
    const channelId = BigInt(channelIdRaw)

    const channel = await databaseServices.prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, workspaceId: true }
    })

    if (!channel || !channel.workspaceId) {
      throw new ErrorWithStatus({
        message: 'Không tìm thấy channel hoặc channel không thuộc workspace nào',
        status: httpStatus.NOTFOUND
      })
    }

    const workspaceMember = await databaseServices.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId } },
      select: { status: true }
    })

    if (!workspaceMember || workspaceMember.status !== MemberStatus.ACTIVE) {
      throw new ErrorWithStatus({
        message: 'Bạn không thuộc workspace của channel này',
        status: httpStatus.FORBIDDEN
      })
    }

    const channelMember = await databaseServices.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      select: { role: true, status: true }
    })

    if (!channelMember || channelMember.status !== MemberStatus.ACTIVE) {
      throw new ErrorWithStatus({
        message: 'Bạn không phải thành viên của channel này',
        status: httpStatus.FORBIDDEN
      })
    }

    if (!allowedRoles.includes(channelMember.role as ChannelMemberRole)) {
      throw new ErrorWithStatus({
        message: 'Bạn không đủ quyền cho thao tác này trên channel',
        status: httpStatus.FORBIDDEN
      })
    }

    req.channelMember = {
      role: channelMember.role as ChannelMemberRole,
      status: channelMember.status as MemberStatus
    }

    next()
  }
}

export const checkChannelExistAndUserIsMember = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
) => {
  const channelIdRaw = req.params.channelId as string
  const { user_id } = req.decode_authorization

  if (!channelIdRaw || !user_id) {
    throw new ErrorWithStatus({
      message: 'Không tìm thấy channelId hoặc user_id',
      status: httpStatus.NOTFOUND
    })
  }

  const findChannel = await databaseServices.prisma.channel.findUnique({
    where: { id: BigInt(channelIdRaw) },
    select: { id: true, workspaceId: true }
  })

  if (!findChannel) {
    throw new ErrorWithStatus({
      message: 'Không tìm thấy channel',
      status: httpStatus.NOTFOUND
    })
  }

  const findMemberInChannel = await databaseServices.prisma.channelMember.findUnique({
    where: { channelId_userId: { channelId: findChannel.id, userId: BigInt(user_id) } }
  })

  if (!findMemberInChannel || findMemberInChannel.status !== MemberStatus.ACTIVE) {
    throw new ErrorWithStatus({
      message: 'Bạn không phải thành viên của channel này',
      status: httpStatus.FORBIDDEN
    })
  }

  next()
}

export const checkChannelExistOnly = async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  const channelIdRaw = req.params.channelId as string

  if (!channelIdRaw) {
    throw new ErrorWithStatus({
      message: 'Không tìm thấy channelId',
      status: httpStatus.NOTFOUND
    })
  }

  const findChannel = await databaseServices.prisma.channel.findUnique({
    where: { id: BigInt(channelIdRaw) },
    select: { id: true, workspaceId: true, type: true, isPrivate: true }
  })

  if (!findChannel) {
    throw new ErrorWithStatus({
      message: 'Không tìm thấy channel',
      status: httpStatus.NOTFOUND
    })
  }

  next()
}
