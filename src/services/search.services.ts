/* eslint-disable @typescript-eslint/no-unused-vars */
import databaseServices from '~/services/database.services'
import { Prisma } from '~/generated/prisma/client'
import { MemberStatus } from '~/constants/enum'
import { buildChannelMemberMap, buildFriendStatusMap, normalizeSearchParams } from '~/utils/utils'
import { ChannelType } from '~/models/responses/channel.response'

export type SearchType = 'all' | 'users' | 'channels'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

const userSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  avatar: true,
  createdAt: true,
  fullName: true,
  phone: true,
  bio: true,
  dateOfBirth: true,
  gender: true
} as const

const channelSelect = {
  id: true,
  name: true,
  description: true,
  type: true,
  workspaceId: true,
  categoryId: true,
  workspace: {
    select: {
      id: true,
      name: true,
      ownerId: true,
      owner: {
        select: {
          id: true,
          username: true,
          fullName: true,
          avatar: true
        }
      }
    }
  }
} as const

const stableUserOrder: Prisma.UserOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'asc' }]
const stableChannelOrder: Prisma.ChannelOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'asc' }]

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>
type ChannelRow = Prisma.ChannelGetPayload<{ select: typeof channelSelect }>

function paginate(skip: number, limit: number, totals: { users: number; channels: number }) {
  const userSkip = Math.min(skip, totals.users)
  const userTake = Math.max(0, Math.min(limit, totals.users - userSkip))
  const channelTakeNeeded = limit - userTake
  const channelSkip = Math.max(0, skip - totals.users)
  const channelTake = Math.max(0, Math.min(channelTakeNeeded, totals.channels - channelSkip))
  return { userSkip, userTake, channelSkip, channelTake }
}

function buildUserWhere(meId: bigint, searchTerm: string): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = { id: { not: meId } }
  if (searchTerm) {
    where.OR = [
      { username: { contains: searchTerm, mode: 'insensitive' } },
      { fullName: { contains: searchTerm, mode: 'insensitive' } }
    ]
  }
  return where
}

function buildChannelWhere(meId: bigint, searchTerm: string): Prisma.ChannelWhereInput {
  // trừ những channel của chính mình
  // trừ những channel private
  // trừ những channel DM
  const where: Prisma.ChannelWhereInput = {
    NOT: { OR: [{ type: ChannelType.DM }, { members: { some: { userId: BigInt(meId) } } }] },
    isPrivate: false
  }
  if (searchTerm) {
    where.OR = [
      { name: { contains: searchTerm, mode: 'insensitive' } },
      { description: { contains: searchTerm, mode: 'insensitive' } }
    ]
  }
  return where
}

class SearchService {
  async searchUsersOnly(
    userWhere: Prisma.UserWhereInput,
    meId: string,
    pageNumber: number,
    limitNumber: number,
    skip: number
  ) {
    const [totalUsers, users] = await Promise.all([
      databaseServices.prisma.user.count({ where: userWhere }),
      databaseServices.prisma.user.findMany({
        where: userWhere,
        skip,
        take: limitNumber,
        orderBy: stableUserOrder,
        select: userSelect
      })
    ])
    const friendStatusMap = await buildFriendStatusMap(
      meId,
      users.map((u) => u.id)
    )
    return {
      items: users.map((user) => {
        return {
          ...user,
          id: user.id.toString(),
          type: 'user' as const,
          friendStatus: friendStatusMap.get(user.id.toString()) ?? null
        }
      }),
      page: pageNumber,
      limit: limitNumber,
      total: totalUsers,
      totalPages: Math.ceil(totalUsers / limitNumber)
    }
  }

  async searchChannelsOnly(
    channelWhere: Prisma.ChannelWhereInput,
    meId: bigint,
    pageNumber: number,
    limitNumber: number,
    skip: number
  ) {
    const [totalChannels, channels] = await Promise.all([
      databaseServices.prisma.channel.count({ where: channelWhere }),
      databaseServices.prisma.channel.findMany({
        where: channelWhere,
        skip,
        take: limitNumber,
        orderBy: stableChannelOrder,
        select: channelSelect
      })
    ])

    const channelMemberMap = await buildChannelMemberMap(
      meId,
      channels.map((c) => c.id)
    )

    return {
      items: channels.map((channel) => {
        const { workspace, ...rest } = channel
        return {
          ...rest,
          id: channel.id.toString(),
          workspaceId: channel.workspaceId?.toString() ?? null,
          categoryId: channel.categoryId?.toString() ?? null,
          workspaceName: channel.workspace?.name ?? null,
          workspaceOwner: channel.workspace?.owner ? channel.workspace.owner.fullName : null,
          type: 'channel' as const,
          channelMemberStatus: (channelMemberMap.get(channel.id.toString()) as MemberStatus | null) ?? null
        }
      }),
      page: pageNumber,
      limit: limitNumber,
      total: totalChannels,
      totalPages: Math.ceil(totalChannels / limitNumber)
    }
  }

  async searchAll(page: string, limit: string, search: string, me_id: string, type: SearchType = 'all') {
    const { pageNumber, limitNumber, skip, searchTerm } = normalizeSearchParams(page, limit, search, {
      defaultLimit: DEFAULT_LIMIT,
      maxLimit: MAX_LIMIT
    })

    const meIdBig = BigInt(me_id)
    const userWhere = buildUserWhere(meIdBig, searchTerm)
    const channelWhere = buildChannelWhere(meIdBig, searchTerm)

    if (type === 'users') {
      return this.searchUsersOnly(userWhere, me_id, pageNumber, limitNumber, skip)
    }

    if (type === 'channels') {
      return this.searchChannelsOnly(channelWhere, meIdBig, pageNumber, limitNumber, skip)
    }

    if (!searchTerm) {
      return this.searchUsersOnly(userWhere, me_id, pageNumber, limitNumber, skip)
    }

    const [totalUsers, totalChannels] = await Promise.all([
      databaseServices.prisma.user.count({ where: userWhere }),
      databaseServices.prisma.channel.count({ where: channelWhere })
    ])
    const total = totalUsers + totalChannels

    const { userSkip, userTake, channelSkip, channelTake } = paginate(skip, limitNumber, {
      users: totalUsers,
      channels: totalChannels
    })

    const [users, channels] = await Promise.all([
      userTake > 0
        ? databaseServices.prisma.user.findMany({
            where: userWhere,
            skip: userSkip,
            take: userTake,
            orderBy: stableUserOrder,
            select: userSelect
          })
        : Promise.resolve([] as UserRow[]),
      channelTake > 0
        ? databaseServices.prisma.channel.findMany({
            where: channelWhere,
            skip: channelSkip,
            take: channelTake,
            orderBy: stableChannelOrder,
            select: channelSelect
          })
        : Promise.resolve([] as ChannelRow[])
    ])

    const friendStatusMap = await buildFriendStatusMap(
      me_id,
      users.map((u) => u.id)
    )

    const channelMemberMap = await buildChannelMemberMap(
      meIdBig,
      channels.map((c) => c.id)
    )

    const merged = [
      ...users.map((user) => {
        return {
          ...user,
          id: user.id.toString(),
          type: 'user' as const,
          friendStatus: friendStatusMap.get(user.id.toString()) ?? null
        }
      }),
      ...channels.map((channel) => {
        const { workspace, ...rest } = channel
        return {
          ...rest,
          id: channel.id.toString(),
          workspaceId: channel.workspaceId?.toString() ?? null,
          categoryId: channel.categoryId?.toString() ?? null,
          workspaceName: channel.workspace?.name ?? null,
          workspaceOwner: channel.workspace?.owner ? channel.workspace.owner.fullName : null,
          type: 'channel' as const,
          channelMemberStatus: (channelMemberMap.get(channel.id.toString()) as MemberStatus | null) ?? null
        }
      })
    ]

    return {
      items: merged,
      page: pageNumber,
      limit: limitNumber,
      total,
      totalPages: Math.ceil(total / limitNumber)
    }
  }
}

export const searchService = new SearchService()
