/* eslint-disable @typescript-eslint/no-explicit-any */
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
        OR: [{ ownerId: userId }, { members: { some: { userId } } }]
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
}

export default new Workspace()
