import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { envConfig } from '~/utils/config'
import { verifyToken } from '~/utils/jwt'
import { Request } from 'express'
import { JsonWebTokenError } from 'jsonwebtoken'
import { FriendStatus, FriendStatusRequest } from '~/constants/enum'
import databaseServices from '~/services/database.services'
import { WorkspaceMemberStatus } from '~/models/responses/workspace.response'

export const verifyAccessToken = async (access_token: string, req?: Request) => {
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
    if (req) {
      req.decode_authorization = decode_authorization
      return true
    }
    return decode_authorization
  } catch (error) {
    if (error instanceof JsonWebTokenError) {
      throw new ErrorWithStatus({
        message: 'AccessToken expired',
        status: httpStatus.UNAUTHORIZED
      })
    }
  }
}

export const normalizeSearchParams = (
  page: string | undefined,
  limit: string | undefined,
  search: string | undefined,
  options: { defaultLimit?: number; maxLimit?: number } = {}
) => {
  const defaultLimit = options.defaultLimit ?? 10
  const maxLimit = options.maxLimit ?? 100

  const pageNumber = Math.max(Number(page) || 1, 1)
  const rawLimit = Number(limit) || defaultLimit
  const limitNumber = Math.min(Math.max(rawLimit, 1), maxLimit)
  const searchTerm = (search ?? '').trim()

  return {
    pageNumber,
    limitNumber,
    skip: (pageNumber - 1) * limitNumber,
    searchTerm
  }
}

export const buildFriendStatusMap = async (
  meId: string,
  otherUserIds: bigint[]
): Promise<Map<string, FriendStatusRequest | null>> => {
  const map = new Map<string, FriendStatusRequest | null>()
  if (otherUserIds.length === 0) return map

  const friendships = await databaseServices.prisma.friend.findMany({
    where: {
      OR: [
        { requesterId: BigInt(meId), addresseeId: { in: otherUserIds } },
        { requesterId: { in: otherUserIds }, addresseeId: BigInt(meId) }
      ]
    },
    select: {
      status: true,
      requesterId: true,
      addresseeId: true
    }
  })

  for (const id of otherUserIds) {
    map.set(id.toString(), null)
  }

  for (const f of friendships) {
    const otherId = f.requesterId === BigInt(meId) ? f.addresseeId : f.requesterId

    if (f.status === FriendStatus.ACCEPTED) {
      map.set(otherId.toString(), FriendStatusRequest.ACCEPTED)
    } else if (f.status === FriendStatus.PENDING) {
      map.set(
        otherId.toString(),
        f.requesterId === BigInt(meId) ? FriendStatusRequest.REQUEST_SENT : FriendStatusRequest.REQUEST_RECEIVED
      )
    }
  }

  return map
}

export const buildWorkspaceMemberMap = async (meId: bigint, otherWorkspaceIds: bigint[]) => {
  const existingMember = await databaseServices.prisma.workspaceMember.findMany({
    where: {
      workspaceId: {
        in: otherWorkspaceIds.map((w) => w)
      },
      userId: BigInt(meId)
    },
    select: {
      status: true,
      workspaceId: true
    }
  })

  const workspaceMemberMap = new Map<string, WorkspaceMemberStatus>()
  for (const member of existingMember) {
    workspaceMemberMap.set(member.workspaceId.toString(), member.status as WorkspaceMemberStatus)
  }

  return workspaceMemberMap
}
