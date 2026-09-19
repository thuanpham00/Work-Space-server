/* eslint-disable @typescript-eslint/no-explicit-any */
import { WorkspaceMemberRole } from '~/constants/enum'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { Channel } from '~/models/responses/channel.response'
import {
  type Workspace as WorkspaceResponse,
  type WorkspaceCategory,
  WorkspaceMemberStatus
} from '~/models/responses/workspace.response'
import databaseServices from '~/services/database.services'
class Workspace {
  private getDataCategory(categoryData: any[]): WorkspaceCategory[] {
    return categoryData
      .sort((a, b) => a.position - b.position)
      .map((category) => ({
        ...category,
        id: category.id.toString(),
        workspaceId: category.workspaceId.toString(),
        name: category.name ? category.name : null,
        position: category.position,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
        channels: category.channels
          ? category.channels
              .sort((a: Channel, b: Channel) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
              .map((channel: Channel) => ({
                ...channel,
                id: channel.id.toString(),
                workspaceId: channel.workspaceId ? channel.workspaceId.toString() : null,
                categoryId: channel.categoryId ? channel.categoryId.toString() : null,
                name: channel.name ? channel.name : null,
                description: channel.description ? channel.description : null,
                type: channel.type ? channel.type : null,
                createdAt: channel.createdAt,
                updatedAt: channel.updatedAt
              }))
          : []
      }))
  }

  async getWorkspacesOfUser(userId: bigint): Promise<WorkspaceResponse[]> {
    const workspaces = await databaseServices.prisma.workspace.findMany({
      where: {
        OR: [{ ownerId: userId }, { members: { some: { userId, status: WorkspaceMemberStatus.ACTIVE } } }]
      },
      include: {
        categories: {
          include: {
            channels: true
          }
        }
      }
    })

    return workspaces.map((workspace) => {
      const categories = this.getDataCategory(workspace.categories)

      return {
        ...workspace,
        id: workspace.id.toString(),
        ownerId: workspace.ownerId ? workspace.ownerId.toString() : null,
        name: workspace.name ? workspace.name : null,
        description: workspace.description ? workspace.description : null,
        avatar: workspace.avatar ? workspace.avatar : null,
        createdAt: workspace.createdAt.toISOString(),
        updatedAt: workspace.updatedAt.toISOString(),
        categories
      }
    })
  }

  async getWorkspaceMembers(workspaceId: bigint, currentUserId: string, search: string, page: number, limit: number) {
    const keyword = search.trim()

    const me = await databaseServices.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: BigInt(currentUserId) } }
    })

    const isActiveMember = me && me.status === WorkspaceMemberStatus.ACTIVE

    if (!isActiveMember) {
      throw new ErrorWithStatus({
        message: 'Bạn không có quyền xem danh sách thành viên workspace này',
        status: httpStatus.FORBIDDEN
      })
    }

    const where: any = {
      workspaceId,
      status: WorkspaceMemberStatus.ACTIVE
    }

    if (keyword) {
      where.user = {
        OR: [
          { username: { contains: keyword, mode: 'insensitive' } },
          { fullName: { contains: keyword, mode: 'insensitive' } }
        ]
      }
    }

    const [members, total] = await Promise.all([
      databaseServices.prisma.workspaceMember.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              avatar: true,
              fullName: true,
              status: true
            }
          }
        },
        orderBy: { joinedAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit
      }),
      databaseServices.prisma.workspaceMember.count({ where })
    ])

    return {
      members: members.map((m) => ({
        id: m.user.id.toString(),
        username: m.user.username,
        avatar: m.user.avatar,
        fullName: m.user.fullName,
        status: m.user.status,
        role: m.role,
        joinedAt: m.joinedAt?.toISOString() ?? null
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  }

  async getWorkspaceRequests(workspaceId: bigint, currentUserId: string) {
    const me = await databaseServices.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: BigInt(currentUserId) } }
    })

    const isAdmin =
      me &&
      me.status === WorkspaceMemberStatus.ACTIVE &&
      (me.role === WorkspaceMemberRole.OWNER || me.role === WorkspaceMemberRole.ADMIN)

    if (!isAdmin) {
      throw new ErrorWithStatus({
        message: 'Bạn không có quyền xem danh sách lời mời / yêu cầu tham gia',
        status: httpStatus.FORBIDDEN
      })
    }

    const requests = await databaseServices.prisma.workspaceMember.findMany({
      where: {
        workspaceId,
        status: {
          in: [WorkspaceMemberStatus.PENDING_INVITE, WorkspaceMemberStatus.PENDING_REQUEST]
        }
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true,
            fullName: true,
            status: true
          }
        }
      },
      orderBy: { invitedAt: 'desc' }
    })

    const inviterIds = [
      ...new Set(requests.map((r) => r.invitedById).filter((id): id is bigint => id !== null))
    ]
    const inviters = inviterIds.length
      ? await databaseServices.prisma.user.findMany({
          where: { id: { in: inviterIds } },
          select: { id: true, displayName: true, username: true }
        })
      : []
    const inviterMap = new Map(inviters.map((u) => [u.id.toString(), u]))

    return requests.map((r) => {
      const inviter = r.invitedById ? inviterMap.get(r.invitedById.toString()) : null
      return {
        userId: r.user.id.toString(),
        username: r.user.username,
        avatar: r.user.avatar,
        fullName: r.user.fullName,
        status: r.user.status,
        role: r.role,
        type: r.status === WorkspaceMemberStatus.PENDING_INVITE ? 'invite' : 'join',
        invitedById: r.invitedById?.toString() ?? null,
        invitedByName: inviter?.displayName ?? inviter?.username ?? null,
        requestedById: r.requestedById?.toString() ?? null,
        invitedAt: r.invitedAt?.toISOString() ?? null,
        joinedAt: null
      }
    })
  }

  async getWorkSpaceDetail(workspaceId: bigint): Promise<WorkspaceResponse | null> {
    const workspace = await databaseServices.prisma.workspace.findFirstOrThrow({
      where: {
        id: workspaceId
      },
      include: {
        categories: {
          include: {
            channels: true
          }
        }
      }
    })

    if (!workspace) return null

    const categories = this.getDataCategory(workspace.categories)

    return {
      ...workspace,
      id: workspace.id.toString(),
      ownerId: workspace.ownerId ? workspace.ownerId.toString() : null,
      name: workspace.name ? workspace.name : null,
      description: workspace.description ? workspace.description : null,
      avatar: workspace.avatar ? workspace.avatar : null,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
      categories
    }
  }

  async getWorkspaceMemberStatus(workspaceId: bigint, userId: bigint) {
    const workspace = await databaseServices.prisma.workspace.findFirst({
      where: {
        id: workspaceId
      },
      include: {
        owner: true
      }
    })

    if (!workspace) return null

    const statusMemberWorkspace = await databaseServices.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId
      }
    })

    return {
      ...workspace,
      workspaceStatus: statusMemberWorkspace?.status || null
    }
  }

  /**
   * User gửi request xin join vào workspace
   * - status: PENDING_REQUEST (chờ duyệt)
   * - requestedById: id của user gửi request
   */
  async requestToJoinWorkspace(workspaceId: bigint, userId: bigint) {
    const workspace = await databaseServices.prisma.workspace.findUnique({
      where: { id: workspaceId }
    })

    if (!workspace) {
      throw new ErrorWithStatus({
        message: 'Workspace không tồn tại',
        status: httpStatus.NOTFOUND
      })
    }

    if (workspace.ownerId === userId) {
      throw new ErrorWithStatus({
        message: 'Bạn là owner của workspace này, không cần gửi yêu cầu tham gia',
        status: httpStatus.BAD_REQUESTED
      })
    }

    const existingMember = await databaseServices.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId
        }
      }
    })

    if (existingMember) {
      if (existingMember.status === 'ACTIVE') {
        throw new ErrorWithStatus({
          message: 'Bạn đã là thành viên của workspace này',
          status: httpStatus.BAD_REQUESTED
        })
      }
      if (existingMember.status === 'PENDING_REQUEST') {
        throw new ErrorWithStatus({
          message: 'Bạn đã gửi yêu cầu tham gia trước đó, vui lòng chờ duyệt',
          status: httpStatus.BAD_REQUESTED
        })
      }
      if (existingMember.status === 'PENDING_INVITE') {
        throw new ErrorWithStatus({
          message: 'Bạn đang có lời mời tham gia workspace này',
          status: httpStatus.BAD_REQUESTED
        })
      }
      if (
        existingMember.status === 'REJECTED' ||
        existingMember.status === 'LEFT' ||
        existingMember.status === 'CANCELLED'
      ) {
        const updatedMember = await databaseServices.prisma.workspaceMember.update({
          where: {
            workspaceId_userId: {
              workspaceId,
              userId
            }
          },
          data: {
            status: WorkspaceMemberStatus.PENDING_REQUEST,
            role: 'MEMBER',
            requestedById: userId,
            invitedById: null,
            approvedById: null,
            approvedByType: null,
            acceptedAt: null,
            rejectedAt: null,
            joinedAt: null
          }
        })

        return updatedMember
      }
    }

    // 4. Tạo bản ghi workspaceMember mới với status PENDING_REQUEST
    const newMember = await databaseServices.prisma.workspaceMember.create({
      data: {
        workspaceId,
        userId,
        role: 'MEMBER',
        status: WorkspaceMemberStatus.PENDING_REQUEST,
        requestedById: userId
      }
    })

    return newMember
  }

  /**
   * User rút yêu cầu tham gia workspace
   * - Chỉ có thể hủy khi status là PENDING_REQUEST
   * - Không được hủy nếu là PENDING_INVITE (phải từ chối invite)
   */
  async cancelJoinRequest(workspaceId: bigint, userId: bigint) {
    const existingMember = await databaseServices.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId
        }
      }
    })

    if (!existingMember) {
      throw new ErrorWithStatus({
        message: 'Bạn chưa có yêu cầu tham gia workspace này',
        status: httpStatus.NOTFOUND
      })
    }

    if (existingMember.status === WorkspaceMemberStatus.PENDING_INVITE) {
      throw new ErrorWithStatus({
        message: 'Bạn có lời mời tham gia workspace này, không thể hủy yêu cầu. Vui lòng từ chối lời mời.',
        status: httpStatus.BAD_REQUESTED
      })
    }

    if (existingMember.status !== WorkspaceMemberStatus.PENDING_REQUEST) {
      throw new ErrorWithStatus({
        message: 'Không thể hủy yêu cầu tham gia vì trạng thái không hợp lệ',
        status: httpStatus.BAD_REQUESTED
      })
    }

    const updatedMember = await databaseServices.prisma.workspaceMember.update({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId
        }
      },
      data: {
        status: WorkspaceMemberStatus.CANCELLED,
        requestedById: null
      }
    })

    return updatedMember
  }
}

export default new Workspace()
