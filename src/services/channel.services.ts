/* eslint-disable @typescript-eslint/no-explicit-any */
import { configChannel } from '~/constants/channel'
import { ChannelMemberRole, ChannelType, MessageType } from '~/constants/enum'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { ChannelNicknameBody, UpdateChannelConfigBody } from '~/models/requests/channel.request'
import { CreateChannelBody, UpdateChannelBody } from '~/models/schemas/channel.schema'
import databaseServices from './database.services'
import { AttachmentType } from '~/models/responses/attachment.response'

class ChannelService {
  async createChannel({ categoryId, name, description, type, isPrivate, isDefault }: CreateChannelBody) {
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

    // Validation logic: isPrivate = true → isDefault = false
    const finalIsDefault = isPrivate ? false : (isDefault ?? false)

    const channel = await databaseServices.prisma.channel.create({
      data: {
        workspaceId: category.workspaceId,
        categoryId: category.id,
        name,
        description: description ?? null,
        type: type.toUpperCase() as ChannelType,
        isPrivate: isPrivate ?? false,
        isDefault: finalIsDefault,
        config: {
          create: {
            accent: configChannel.defaultAccent,
            backgroundUrl: ''
          }
        },
        ...(nicknamesData.length > 0 && {
          nicknames: {
            create: nicknamesData
          }
        }),
        members: {
          create: {
            userId: category.workspace.ownerId!,
            role: ChannelMemberRole.ADMIN,
            joinedAt: new Date()
          }
        }
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
      isDefault: channel.isDefault,
      createdAt: channel.createdAt.toISOString(),
      updatedAt: channel.updatedAt.toISOString()
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

  async getAttachmentsForChannel(channelId: bigint, limit: number, page: number, type: string) {
    // lấy danh sách tin nhắn thuộc về channelId từ đó lấy danh sách attachments

    // nếu type === image thì attachment.mimeType.startsWith("image/")
    // nếu type === file thì !attachment.mimeType.startsWith("image/")
    const where = {
      message: {
        channelId
      },
      mimeType:
        type === AttachmentType.IMAGE
          ? {
              startsWith: 'image/'
            }
          : {
              not: {
                startsWith: 'image/'
              }
            }
    }

    const [attachments, total] = await Promise.all([
      databaseServices.prisma.attachment.findMany({
        where,
        take: limit,
        skip: (page - 1) * limit,
        orderBy: {
          createdAt: 'desc'
        }
      }),
      databaseServices.prisma.attachment.count({
        where
      })
    ])

    return {
      resAttachments: attachments,
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
                status: true,
                fullName: true,
                privacySettings: true,
                phone: true,
                gender: true,
                dateOfBirth: true,
                createdAt: true
              }
            }
          }
        },
        config: true,
        nicknames: {
          include: {
            user: true
          }
        },
        category: true
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
      isDefault: channel.isDefault,
      createdAt: channel.createdAt.toISOString(),
      updatedAt: channel.updatedAt.toISOString(),
      members: channel.members.map((m) => ({
        joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
        role: m.role,
        userId: m.userId.toString(),
        email: m.user.email,
        username: m.user.username,
        displayName: m.user.displayName,
        avatar: m.user.avatar,
        status: m.user.status,
        fullName: m.user.fullName,
        privacySettings: m.user.privacySettings,
        phone: m.user.phone,
        gender: m.user.gender,
        dateOfBirth: m.user.dateOfBirth,
        createdAt: m.user.createdAt.toISOString()
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
        : null,
      category: channel.category
        ? {
            ...channel.category,
            id: channel.category.id.toString()
          }
        : null
    }
  }

  async updateChannel(channelId: bigint, body: UpdateChannelBody) {
    // Kiểm tra channel có tồn tại không
    const existingChannel = await databaseServices.prisma.channel.findUnique({
      where: { id: channelId }
    })

    if (!existingChannel) {
      throw new ErrorWithStatus({
        message: 'Channel không tồn tại',
        status: httpStatus.NOTFOUND
      })
    }

    // Nếu update categoryId thì kiểm tra category có tồn tại không
    if (body.categoryId !== undefined) {
      const category = await databaseServices.prisma.categoryChannel.findUnique({
        where: { id: BigInt(body.categoryId) }
      })

      if (!category) {
        throw new ErrorWithStatus({
          message: 'Category không tồn tại',
          status: httpStatus.NOTFOUND
        })
      }
    }

    // Validation logic: isPrivate = true → isDefault = false
    const finalIsPrivate = body.isPrivate !== undefined ? body.isPrivate : existingChannel.isPrivate
    const finalIsDefault = body.isDefault !== undefined ? body.isDefault : existingChannel.isDefault

    if (finalIsPrivate === true && finalIsDefault === true) {
      throw new ErrorWithStatus({
        message: 'Channel private không thể là channel mặc định (isDefault phải là false)',
        status: httpStatus.BAD_REQUESTED
      })
    }

    // Build data update - không cho phép update type
    const updateData: any = {}
    if (body.name !== undefined) updateData.name = body.name
    if (body.description !== undefined) updateData.description = body.description
    if (body.categoryId !== undefined) updateData.categoryId = BigInt(body.categoryId)
    if (body.isPrivate !== undefined) updateData.isPrivate = body.isPrivate
    if (body.isDefault !== undefined) updateData.isDefault = body.isDefault

    const updatedChannel = await databaseServices.prisma.channel.update({
      where: { id: channelId },
      data: updateData
    })

    return {
      id: updatedChannel.id.toString(),
      workspaceId: updatedChannel.workspaceId ? updatedChannel.workspaceId.toString() : null,
      categoryId: updatedChannel.categoryId ? updatedChannel.categoryId.toString() : null,
      name: updatedChannel.name,
      description: updatedChannel.description,
      type: updatedChannel.type,
      isPrivate: updatedChannel.isPrivate,
      isDefault: updatedChannel.isDefault,
      createdAt: updatedChannel.createdAt.toISOString(),
      updatedAt: updatedChannel.updatedAt.toISOString()
    }
  }

  async updateChannelConfig(channelId: bigint, config: UpdateChannelConfigBody, userId: bigint) {
    const channelConfig = await databaseServices.prisma.channelConfig.update({
      where: {
        channelId: channelId
      },
      data: {
        backgroundUrl: config.backgroundUrl,
        accent: config.accent
      }
    })

    const configMessage = await databaseServices.prisma.message.create({
      data: {
        channelId,
        senderId: userId,
        messageType: MessageType.CONFIG,
        content: JSON.stringify({
          action: 'channel_settings_updated'
        })
      },
      include: {
        sender: true
      }
    })

    return {
      channelConfig: {
        ...channelConfig,
        id: channelConfig.id.toString(),
        channelId: channelConfig.channelId.toString()
      },
      configMessage: {
        ...configMessage,
        id: configMessage.id.toString(),
        channelId: configMessage.channelId.toString(),
        senderId: configMessage.senderId.toString(),
        sender: {
          ...configMessage.sender,
          id: configMessage.sender.id.toString()
        }
      }
    }
  }

  async updateChannelNickname(channelId: bigint, nickname: ChannelNicknameBody, userId: bigint) {
    const findUserTarget = await databaseServices.prisma.user.findUnique({
      where: {
        id: BigInt(nickname.userId)
      },
      select: {
        fullName: true
      }
    })

    const updatedNickname = await databaseServices.prisma.channelMemberNickname.update({
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

    const configMessage = await databaseServices.prisma.message.create({
      data: {
        channelId,
        senderId: userId,
        messageType: MessageType.CONFIG,
        content: JSON.stringify({
          action: 'channel_nicknames_updated',
          targetUserName: findUserTarget?.fullName,
          targetUserId: nickname.userId,
          targetNickname: nickname.nickname
        })
      },
      include: {
        sender: true
      }
    })

    return {
      channelNickname: {
        ...updatedNickname,
        id: updatedNickname.id.toString(),
        channelId: updatedNickname.channelId.toString(),
        userId: updatedNickname.userId.toString()
      },
      configMessage: {
        ...configMessage,
        id: configMessage.id.toString(),
        channelId: configMessage.channelId.toString(),
        senderId: configMessage.senderId.toString(),
        sender: {
          ...configMessage.sender,
          id: configMessage.sender.id.toString()
        }
      }
    }
  }

  async getUnreadChannel(userId: bigint) {
    // lấy những channel (ko có workspace - channel DM) mà user tham gia và check unreadState
    const channelList = await databaseServices.prisma.channelMember.findMany({
      where: {
        userId: userId
      },
      select: {
        channelId: true,
        channel: true
      }
    })

    const channelIds = channelList.map((m) => m.channelId)
    if (channelIds.length === 0) return []

    const readChannelStateMap = new Map()
    const lastMessageMap = new Map()

    const readChannelStates = await databaseServices.prisma.channelReadState.findMany({
      where: {
        channelId: { in: channelIds },
        userId: userId
      },
      select: {
        channelId: true,
        lastReadMessageId: true,
        lastReadAt: true
      }
    })

    for (const readChannelState of readChannelStates) {
      const key = readChannelState.channelId.toString()
      if (!readChannelStateMap.has(key)) {
        readChannelStateMap.set(key, readChannelState)
      }
    }

    const lastMessage = await databaseServices.prisma.message.findMany({
      where: {
        channelId: { in: channelIds },
        messageType: { not: 'CONFIG' }
      },
      orderBy: {
        createdAt: 'desc'
      }
    })

    for (const message of lastMessage) {
      const key = message.channelId.toString()
      if (!lastMessageMap.has(key)) {
        lastMessageMap.set(key, message.id)
      }
    }

    return Promise.all(
      channelIds.map(async (channelId) => {
        const key = channelId.toString()
        const readChannelState = readChannelStateMap.get(key)
        const lastMessageState = lastMessageMap.get(key)
        const findChannel = channelList.find((c) => c.channelId === channelId)

        const count = await databaseServices.prisma.message.count({
          where: {
            channelId: channelId,
            messageType: { not: 'CONFIG' },
            createdAt: {
              gt: readChannelState?.lastReadAt ?? new Date(0)
            }
          }
        })

        return {
          workspaceId: findChannel?.channel.workspaceId,
          channelId,
          type: findChannel?.channel.type,
          lastMessageId: lastMessageState,
          count: count,
          unread: count > 0
        }
      })
    )
  }
}

export default new ChannelService()
