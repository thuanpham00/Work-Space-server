import databaseServices from '~/services/database.services'

class Workspace {
  async getWorkspacesOfUser(userId: bigint) {
    const workspaces = await databaseServices.prisma.workspace.findMany({
      where: {
        OR: [{ ownerId: userId }, { members: { some: { userId } } }]
      }
    })

    return workspaces.map((workspace) => ({
      ...workspace,
      id: workspace.id.toString(),
      ownerId: workspace.ownerId ? workspace.ownerId.toString() : null,
      name: workspace.name ? workspace.name : null,
      description: workspace.description ? workspace.description : null,
      avatar: workspace.avatar ? workspace.avatar : null,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString()
    }))
  }

  async getWorkSpaceDetail(workspaceId: bigint) {
    const workspace = await databaseServices.prisma.workspace.findFirstOrThrow({
      where: {
        id: workspaceId
      },
      include: {
        channels: true
      }
    })

    if (!workspace) return null

    return {
      ...workspace,
      id: workspace?.id.toString(),
      ownerId: workspace?.ownerId ? workspace.ownerId.toString() : null,
      name: workspace?.name ? workspace.name : null,
      description: workspace?.description ? workspace.description : null,
      avatar: workspace?.avatar ? workspace.avatar : null,
      createdAt: workspace?.createdAt.toISOString(),
      updatedAt: workspace?.updatedAt.toISOString(),
      channels: workspace?.channels.map((channel) => ({
        ...channel,
        id: channel.id.toString(),
        isPrivate: channel.isPrivate,
        type: channel.type ? channel.type : null,
        name: channel.name ? channel.name : null,
        description: channel.description ? channel.description : null,
        workspaceId: channel.workspaceId ? channel.workspaceId.toString() : null,
        createdAt: channel.createdAt.toISOString(),
        updatedAt: channel.updatedAt.toISOString()
      }))
    }
  }
}

export default new Workspace()
