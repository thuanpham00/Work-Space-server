import databaseServices from '~/services/database.services'
import { Prisma } from '~/generated/prisma/client'
import { FriendStatusRequest } from '~/constants/enum'
import { buildFriendStatusMap, normalizeSearchParams } from '~/utils/utils'

export type SearchType = 'all' | 'users' | 'workspaces'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

const userSelect = {
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
} as const

const workspaceSelect = {
  id: true,
  name: true,
  description: true,
  avatar: true,
  ownerId: true,
  owner: {
    select: {
      id: true,
      username: true,
      fullName: true,
      avatar: true
    }
  },
  createdAt: true
} as const

const stableUserOrder: Prisma.UserOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'asc' }]
const stableWorkspaceOrder: Prisma.WorkspaceOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'asc' }]

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>
type WorkspaceRow = Prisma.WorkspaceGetPayload<{ select: typeof workspaceSelect }>
type FriendStatusMap = Map<string, FriendStatusRequest | null>

function toUserItem(user: UserRow, friendStatusMap: FriendStatusMap) {
  return {
    ...user,
    id: user.id.toString(),
    type: 'user' as const,
    friendStatus: friendStatusMap.get(user.id.toString()) ?? null
  }
}

function toWorkspaceItem(workspace: WorkspaceRow) {
  return {
    ...workspace,
    id: workspace.id.toString(),
    ownerId: workspace.ownerId ? workspace.ownerId.toString() : null,
    type: 'workspace' as const
  }
}

function paginate(skip: number, limit: number, totals: { users: number; workspaces: number }) {
  const userSkip = Math.min(skip, totals.users)
  const userTake = Math.max(0, Math.min(limit, totals.users - userSkip))
  const workspaceTakeNeeded = limit - userTake
  const workspaceSkip = Math.max(0, skip - totals.users)
  const workspaceTake = Math.max(0, Math.min(workspaceTakeNeeded, totals.workspaces - workspaceSkip))
  return { userSkip, userTake, workspaceSkip, workspaceTake }
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

function buildWorkspaceWhere(meId: bigint, searchTerm: string): Prisma.WorkspaceWhereInput {
  const where: Prisma.WorkspaceWhereInput = { ownerId: { not: meId } }
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
      items: users.map((u) => toUserItem(u, friendStatusMap)),
      page: pageNumber,
      limit: limitNumber,
      total: totalUsers,
      totalPages: Math.ceil(totalUsers / limitNumber)
    }
  }

  async searchWorkspacesOnly(
    workspaceWhere: Prisma.WorkspaceWhereInput,
    pageNumber: number,
    limitNumber: number,
    skip: number
  ) {
    const [totalWorkspaces, workspaces] = await Promise.all([
      databaseServices.prisma.workspace.count({ where: workspaceWhere }),
      databaseServices.prisma.workspace.findMany({
        where: workspaceWhere,
        skip,
        take: limitNumber,
        orderBy: stableWorkspaceOrder,
        select: workspaceSelect
      })
    ])
    return {
      items: workspaces.map(toWorkspaceItem),
      page: pageNumber,
      limit: limitNumber,
      total: totalWorkspaces,
      totalPages: Math.ceil(totalWorkspaces / limitNumber)
    }
  }

  async searchAll(page: string, limit: string, search: string, me_id: string, type: SearchType = 'all') {
    const { pageNumber, limitNumber, skip, searchTerm } = normalizeSearchParams(page, limit, search, {
      defaultLimit: DEFAULT_LIMIT,
      maxLimit: MAX_LIMIT
    })

    const meIdBig = BigInt(me_id)
    const userWhere = buildUserWhere(meIdBig, searchTerm)
    const workspaceWhere = buildWorkspaceWhere(meIdBig, searchTerm)

    if (type === 'users') {
      return this.searchUsersOnly(userWhere, me_id, pageNumber, limitNumber, skip)
    }

    if (type === 'workspaces') {
      return this.searchWorkspacesOnly(workspaceWhere, pageNumber, limitNumber, skip)
    }

    if (!searchTerm) {
      return this.searchUsersOnly(userWhere, me_id, pageNumber, limitNumber, skip)
    }

    const [totalUsers, totalWorkspaces] = await Promise.all([
      databaseServices.prisma.user.count({ where: userWhere }),
      databaseServices.prisma.workspace.count({ where: workspaceWhere })
    ])
    const total = totalUsers + totalWorkspaces

    const { userSkip, userTake, workspaceSkip, workspaceTake } = paginate(skip, limitNumber, {
      users: totalUsers,
      workspaces: totalWorkspaces
    })

    const [users, workspaces] = await Promise.all([
      userTake > 0
        ? databaseServices.prisma.user.findMany({
            where: userWhere,
            skip: userSkip,
            take: userTake,
            orderBy: stableUserOrder,
            select: userSelect
          })
        : Promise.resolve([] as UserRow[]),
      workspaceTake > 0
        ? databaseServices.prisma.workspace.findMany({
            where: workspaceWhere,
            skip: workspaceSkip,
            take: workspaceTake,
            orderBy: stableWorkspaceOrder,
            select: workspaceSelect
          })
        : Promise.resolve([] as WorkspaceRow[])
    ])

    const friendStatusMap = await buildFriendStatusMap(
      me_id,
      users.map((u) => u.id)
    )
    const merged = [...users.map((u) => toUserItem(u, friendStatusMap)), ...workspaces.map(toWorkspaceItem)]

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
