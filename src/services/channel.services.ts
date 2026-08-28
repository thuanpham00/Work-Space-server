import { configChannel } from '~/constants/channel'
import { ChannelType } from '~/constants/enum'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { ChannelNicknameBody, UpdateChannelConfigBody } from '~/models/requests/channel.request'
import { CreateChannelBody } from '~/models/schemas/channel.schema'
import databaseServices from './database.services'

class ChannelService {
  async createChannel({ categoryId, name, description, type, isPrivate }: CreateChannelBody) {
    const category = await databaseServices.prisma.categoryChannel.findUnique({
      where: {
        id: BigInt(categoryId)
      },
      include: {
        workspace: {
          select: {
            ownerId: true,
            members: {
              select: {
                userId: true
              }
            }
          }
        }
      }
    })

    if (!category) {
      throw new ErrorWithStatus({
        message: 'Category không tồn tại',
        status: httpStatus.NOTFOUND
      })
    }

    const memberUserIds = new Set<bigint>()
    category.workspace?.members.forEach((member) => memberUserIds.add(member.userId))

    if (category.workspace?.ownerId) {
      memberUserIds.add(category.workspace.ownerId)
    }

    const nicknamesData = Array.from(memberUserIds).map((userId) => ({
      userId,
      nickname: ''
    }))

    const channel = await databaseServices.prisma.channel.create({
      data: {
        workspaceId: category.workspaceId,
        categoryId: category.id,
        name,
        description: description ?? null,
        type: type.toUpperCase() as ChannelType,
        isPrivate: isPrivate ?? false,
        config: {
          create: {
            accent: configChannel.defaultAccent,
            backgroundUrl: '',
            backgroundColor: configChannel.defaultBackgroundColor
          }
        },
        ...(nicknamesData.length > 0 && {
          nicknames: {
            create: nicknamesData
          }
        })
      }
    })

    return {
      id: channel.id.toString(),
      workspaceId: channel.workspaceId ? channel.workspaceId.toString() : null,
      categoryId: channel.categoryId ? channel.categoryId.toString() : null,
      name: channel.name,
      description: channel.description,
      type: channel.type,
      isPrivate: channel.isPrivate,
      createdAt: channel.createdAt.toISOString(),
      updatedAt: channel.updatedAt.toISOString()
    }
  }

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
        },
        config: true,
        nicknames: {
          include: {
            user: true
          }
        }
      }
    })

    if (!channel) return null

    const { members, nicknames, ...restChannel } = channel

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
          })[0] || null,
      nicknames: nicknames.map((nickname) => {
        return {
          ...nickname,
          id: nickname.user.id.toString()
        }
      })
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

  async getAttachmentsForChannel(channelId: bigint, limit: number, page: number) {
    // lấy danh sách tin nhắn thuộc về channelId từ đó lấy danh sách attachments
    const messages = await databaseServices.prisma.message.findMany({
      where: {
        channelId
      },
      select: {
        id: true
      }
    })

    const messageIds = messages.map((message) => message.id)

    const [attachments, total] = await Promise.all([
      databaseServices.prisma.attachment.findMany({
        where: {
          messageId: {
            in: messageIds
          }
        },
        take: limit,
        skip: (page - 1) * limit,
        orderBy: {
          createdAt: 'desc'
        }
      }),
      databaseServices.prisma.attachment.count({
        where: {
          messageId: {
            in: messageIds
          }
        }
      })
    ])

    return {
      attachments,
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
        },
        config: true,
        nicknames: {
          include: {
            user: true
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
      })),
      config: channel.config
        ? {
            ...channel.config,
            id: channel.config.id.toString(),
            channelId: channel.config.channelId.toString()
          }
        : null,
      nicknames: channel.nicknames
        ? channel.nicknames.map((nickname) => {
            return {
              ...nickname,
              id: nickname.user.id.toString()
            }
          })
        : null
    }
  }

  async updateChannelConfig(channelId: bigint, config: UpdateChannelConfigBody) {
    const channelConfig = await databaseServices.prisma.channelConfig.update({
      where: {
        channelId: channelId
      },
      data: {
        backgroundColor: config.backgroundColor,
        backgroundUrl: config.backgroundUrl,
        accent: config.accent
      }
    })

    return {
      channelConfig: {
        ...channelConfig,
        id: channelConfig.id.toString(),
        channelId: channelConfig.channelId.toString()
      }
    }
  }

  async updateChannelNickname(channelId: bigint, nicknames: ChannelNicknameBody[]) {
    const updatedNicknames = await Promise.all(
      nicknames.map(async (nickname) => {
        return await databaseServices.prisma.channelMemberNickname.update({
          where: {
            channelId_userId: {
              channelId,
              userId: BigInt(nickname.userId)
            }
          },
          data: {
            nickname: nickname.nickname,
            updatedAt: new Date()
          }
        })
      })
    )

    return {
      channelNicknames: updatedNicknames.map((nickname) => ({
        ...nickname,
        id: nickname.id.toString()
      }))
    }
  }
}

export default new ChannelService()
