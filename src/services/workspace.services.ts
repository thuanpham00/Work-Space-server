import type { Workspace as WorkspaceResponse, WorkspaceCategory } from '~/models/responses/workspace.response'
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
        createdAt: category.createdAt.toISOString(),
        updatedAt: category.updatedAt.toISOString(),
        channels: category.channels
          ? category.channels.map((channel: any) => ({
              ...channel,
              id: channel.id.toString(),
              workspaceId: channel.workspaceId ? channel.workspaceId.toString() : null,
              categoryId: channel.categoryId ? channel.categoryId.toString() : null,
              name: channel.name ? channel.name : null,
              description: channel.description ? channel.description : null,
              type: channel.type ? channel.type : null,
              createdAt: channel.createdAt.toISOString(),
              updatedAt: channel.updatedAt.toISOString()
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
}

export default new Workspace()
