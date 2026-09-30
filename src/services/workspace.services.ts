/* eslint-disable @typescript-eslint/no-explicit-any */
import { configChannel } from '~/constants/channel'
import { ChannelMemberRole, ChannelType, WorkspaceMemberRole, WorkspaceMemberStatus } from '~/constants/enum'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { Channel, ChannelInviteStatus } from '~/models/responses/channel.response'
import { type Workspace as WorkspaceResponse, type WorkspaceCategory } from '~/models/responses/workspace.response'
import databaseServices from '~/services/database.services'
import { generateUniqueInviteCode } from '~/utils/utils'

class Workspace {
  async createWorkspaceForUser(
    userId: bigint,
    workspaceName: string = 'Workspace mặc định',
    description: string = 'Workspace mặc định được tạo khi đăng ký tài khoản'
  ) {
    await databaseServices.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name: workspaceName,
          description,
          ownerId: userId,
          members: {
            create: [
              {
                userId: userId,
                role: WorkspaceMemberRole.OWNER,
                joinedAt: new Date()
              }
            ]
          }
        }
      })

      const category = await tx.categoryChannel.create({
        data: {
          name: 'Chung',
          position: 0,
          workspaceId: workspace.id
        }
      })

      const defaultChannelSpecs = [
        { name: 'general', description: 'Kênh chung' },
        { name: 'announcements', description: 'Kênh thông báo' },
        { name: 'random', description: 'Kênh tán gẫu' }
      ]

      const createdChannels = []
      for (const spec of defaultChannelSpecs) {
        const channel = await tx.channel.create({
          data: {
            workspaceId: workspace.id,
            categoryId: category.id,
            name: spec.name,
            description: spec.description,
            type: ChannelType.TEXT,
            isPrivate: false,
            isDefault: true
          }
        })

        await tx.channelMember.create({
          data: {
            userId: userId,
            channelId: channel.id,
            role: ChannelMemberRole.ADMIN,
            joinedAt: new Date()
          }
        })

        await tx.channelConfig.create({
          data: {
            accent: configChannel.defaultAccent,
            backgroundUrl: '',
            channelId: channel.id
          }
        })

        createdChannels.push(channel)
      }

      for (const channel of createdChannels) {
        const code = await generateUniqueInviteCode(tx as any)
        await tx.channelInvite.create({
          data: {
            code,
            channelId: channel.id,
            status: ChannelInviteStatus.ACTIVE,
            expiresAt: null,
            createdById: userId
          }
        })

        await tx.channelMemberNickname.create({
          data: {
            nickname: '',
            userId: userId,
            channelId: channel.id
          }
        })
      }
    })
  }

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
              .map((channel: Channel) => {
                const { members, ...rest } = channel
                const role = members?.[0]?.role || null
                return {
                  ...rest,
                  id: channel.id.toString(),
                  workspaceId: channel.workspaceId ? channel.workspaceId.toString() : null,
                  categoryId: channel.categoryId ? channel.categoryId.toString() : null,
                  name: channel.name ? channel.name : null,
                  description: channel.description ? channel.description : null,
                  type: channel.type ? channel.type : null,
                  createdAt: channel.createdAt,
                  updatedAt: channel.updatedAt,
                  role: role
                }
              })
          : []
      }))
  }

  // có
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

  // có
  async getWorkSpaceDetail(workspaceId: bigint, userId: bigint): Promise<WorkspaceResponse | null> {
    const workspace = await databaseServices.prisma.workspace.findFirstOrThrow({
      where: {
        id: workspaceId
      },
      include: {
        categories: {
          include: {
            channels: {
              include: {
                members: {
                  where: {
                    userId: userId
                  },
                  select: {
                    role: true
                  }
                }
              }
            }
          }
        }
      }
    })

    if (!workspace) {
      throw new ErrorWithStatus({
        message: 'Workspace không tồn tại',
        status: httpStatus.NOTFOUND
      })
    }

    const findMember = await databaseServices.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: {
        role: true
      }
    })

    if (!findMember) {
      throw new ErrorWithStatus({
        message: 'Bạn không thuộc workspace này',
        status: httpStatus.FORBIDDEN
      })
    }

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
      role: findMember.role as WorkspaceMemberRole,
      categories
    }
  }

  // có
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
}

export default new Workspace()
