import { ChannelType } from '~/constants/enum'
import databaseServices from './database.services'

class ChannelService {
  async getDirectMessageChannelDetail(idUser: bigint, idReceiver: bigint) {
    const channel = await databaseServices.prisma.channel.findFirst({
      where: {
        type: ChannelType.DM,
        AND: [{ members: { some: { userId: idUser } } }, { members: { some: { userId: idReceiver } } }]
      },
      include: {
        members: {
          include: {
            user: true
          }
        }
      }
    })

    if (!channel) return null

    const { members, ...restChannel } = channel

    return {
      ...restChannel,
      id: channel.id.toString(),
      workspaceId: channel.workspaceId ? channel.workspaceId.toString() : null,
      friend:
        members
          .filter((member) => member.userId !== idUser)
          .map((member) => {
            return {
              ...member.user,
              id: member.user.id.toString()
            }
          })[0] || null
    }
  }

  async getMessagesForDM(channelId: bigint, limit: number, page: number) {
    const [messages, total] = await Promise.all([
      databaseServices.prisma.message.findMany({
        where: {
          channelId
        },
        take: limit,
        skip: (page - 1) * limit,
        orderBy: {
          createdAt: 'desc'
        },
        include: {
          sender: true,
          attachments: true
        }
      }),
      databaseServices.prisma.message.count({
        where: {
          channelId
        }
      })
    ])

    return {
      messages,
      total
    }
  }

  async getChannelDetail(channelId: bigint) {
    const channel = await databaseServices.prisma.channel.findUnique({
      where: {
        id: channelId
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                username: true,
                displayName: true,
                avatar: true,
                status: true
              }
            }
          }
        }
      }
    })

    if (!channel) return null

    return {
      id: channel.id.toString(),
      workspaceId: channel.workspaceId ? channel.workspaceId.toString() : null,
      categoryId: channel.categoryId ? channel.categoryId.toString() : null,
      name: channel.name,
      description: channel.description,
      type: channel.type,
      isPrivate: channel.isPrivate,
      createdAt: channel.createdAt.toISOString(),
      updatedAt: channel.updatedAt.toISOString(),
      members: channel.members.map((m) => ({
        joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
        userId: m.userId.toString(),
        email: m.user.email,
        username: m.user.username,
        displayName: m.user.displayName,
        avatar: m.user.avatar,
        status: m.user.status
      }))
    }
  }
}

export default new ChannelService()
