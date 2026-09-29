/* eslint-disable @typescript-eslint/no-explicit-any */
import { configChannel } from '~/constants/channel'
import {
  ChannelMemberRole,
  ChannelType,
  MessageType,
  MemberStatus,
  WorkspaceMemberRole,
  FriendStatus
} from '~/constants/enum'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { ChannelNicknameBody, UpdateChannelConfigBody } from '~/models/requests/channel.request'
import { CreateChannelBody, UpdateChannelBody } from '~/models/schemas/channel.schema'
import databaseServices from './database.services'
import { AttachmentType } from '~/models/responses/attachment.response'
import { ChannelInviteStatus } from '~/models/responses/channel.response'
import { generateUniqueInviteCode } from '~/utils/utils'
import { envConfig } from '~/utils/config'

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

  async getChannelStatus(channelId: bigint, userId: bigint) {
    const channel = await databaseServices.prisma.channel.findUnique({
      where: {
        id: channelId
      },
      select: {
        id: true,
        workspaceId: true,
        categoryId: true,
        name: true,
        description: true,
        type: true,
        isPrivate: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
        workspace: {
          include: {
            owner: {
              select: {
                id: true,
                username: true,
                avatar: true,
                fullName: true
              }
            }
          }
        }
      }
    })

    const channelMember = await databaseServices.prisma.channelMember.findUnique({
      where: {
        channelId_userId: {
          channelId,
          userId
        }
      },
      select: {
        status: true
      }
    })

    return {
      channel: {
        id: channel?.id.toString(),
        workspaceId: channel?.workspaceId ? channel.workspaceId.toString() : null,
        categoryId: channel?.categoryId ? channel.categoryId.toString() : null,
        name: channel?.name,
        description: channel?.description,
        type: channel?.type,
        isPrivate: channel?.isPrivate,
        isDefault: channel?.isDefault,
        createdAt: channel?.createdAt.toISOString(),
        updatedAt: channel?.updatedAt.toISOString(),
        channelStatus: channelMember ? (channelMember.status as string) : null,
        workspaceOwner: channel?.workspace?.owner
          ? {
              id: channel.workspace.owner.id.toString(),
              username: channel.workspace.owner.username,
              avatar: channel.workspace.owner.avatar,
              fullName: channel.workspace.owner.fullName
            }
          : null
      }
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
                username: true,
                avatar: true,
                fullName: true
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
        role: m.role,
        userId: m.userId.toString(),
        username: m.user.username,
        avatar: m.user.avatar,
        fullName: m.user.fullName
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

  async getActiveInviteLink(channelId: bigint) {
    const invite = await databaseServices.prisma.channelInvite.findFirst({
      where: {
        channelId,
        status: ChannelInviteStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      }
    })

    if (!invite) {
      throw new ErrorWithStatus({
        message: 'Không tìm thấy link mời',
        status: httpStatus.NOTFOUND
      })
    }

    return {
      url: `${envConfig.frontend_url}/invite/${invite.code}`,
      expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null
    }
  }

  /**
   * Tạo link invite mới cho channel (OWNER/ADMIN).
   * - Revoke link ACTIVE cũ (nếu có) trước khi tạo mới → atomic.
   * - ttlSeconds: number = TTL giây; null = không hết hạn; undefined = mặc định 7 ngày.
   */
  async createInviteLink(channelId: bigint, userId: bigint, ttlSeconds?: number | null) {
    // Tính expiresAt
    let expiresAt: Date | null
    if (ttlSeconds === undefined) {
      // Mặc định 7 ngày
      expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    } else if (ttlSeconds === null) {
      expiresAt = null
    } else {
      expiresAt = new Date(Date.now() + ttlSeconds * 1000)
    }

    return await databaseServices.prisma.$transaction(async (tx) => {
      // 1. Revoke tất cả link ACTIVE của channel
      await tx.channelInvite.updateMany({
        where: {
          channelId,
          status: ChannelInviteStatus.ACTIVE
        },
        data: {
          status: ChannelInviteStatus.REVOKED,
          revokedAt: new Date(),
          revokedById: userId
        }
      })

      // 2. Generate unique code
      const code = await generateUniqueInviteCode(tx as any)

      // 3. Tạo link ACTIVE mới
      return await tx.channelInvite.create({
        data: {
          code,
          channelId,
          status: ChannelInviteStatus.ACTIVE,
          expiresAt,
          createdById: userId
        }
      })
    })
  }

  /**
   * Thu hồi link invite channel (OWNER/ADMIN).
   * - Set status = REVOKED, không xóa row (giữ audit trail).
   */
  async revokeInviteLink(channelId: bigint, code: string, userId: bigint) {
    const invite = await databaseServices.prisma.channelInvite.findUnique({
      where: { code }
    })

    if (!invite || invite.channelId !== channelId) {
      throw new ErrorWithStatus({
        message: 'Không tìm thấy link mời',
        status: httpStatus.NOTFOUND
      })
    }

    if (invite.status === ChannelInviteStatus.REVOKED) {
      throw new ErrorWithStatus({
        message: 'Link đã được thu hồi trước đó',
        status: httpStatus.BAD_REQUESTED
      })
    }

    return await databaseServices.prisma.channelInvite.update({
      where: { code },
      data: {
        status: ChannelInviteStatus.REVOKED,
        revokedAt: new Date(),
        revokedById: userId
      }
    })
  }

  async getChannelRequests(channelId: bigint, currentUserId: string) {
    const me = await databaseServices.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId: BigInt(currentUserId) } }
    })

    const isAdmin = me && me.status === MemberStatus.ACTIVE && me.role === ChannelMemberRole.ADMIN

    if (!isAdmin) {
      throw new ErrorWithStatus({
        message: 'Bạn không có quyền xem danh sách lời mời / yêu cầu tham gia channel này',
        status: httpStatus.FORBIDDEN
      })
    }

    const requests = await databaseServices.prisma.channelMember.findMany({
      where: {
        channelId,
        status: {
          in: [MemberStatus.PENDING_INVITE as any, MemberStatus.PENDING_REQUEST as any]
        }
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true,
            fullName: true
          }
        }
      },
      orderBy: { joinedAt: 'desc' }
    })

    const inviterIds = [...new Set(requests.map((r) => r.invitedById).filter((id): id is bigint => id !== null))]
    const inviters = inviterIds.length
      ? await databaseServices.prisma.user.findMany({
          where: { id: { in: inviterIds } },
          select: { id: true, displayName: true, username: true }
        })
      : []
    const inviterMap = new Map(inviters.map((u) => [u.id.toString(), u]))

    return requests.map((r) => ({
      userId: r.user.id.toString(),
      username: r.user.username,
      avatar: r.user.avatar,
      fullName: r.user.fullName,
      role: r.role,
      type: r.status === (MemberStatus.PENDING_INVITE as any) ? 'invite' : 'join',
      invitedById: r.invitedById?.toString() ?? null,
      invitedByName: r.invitedById ? (inviterMap.get(r.invitedById.toString())?.displayName ?? null) : null,
      requestedById: null,
      invitedAt: r.joinedAt.toISOString(),
      joinedAt: null
    }))
  }

  async getFriendsToInviteChannel(userId: bigint, channelId: bigint, search: string, page: number, limit: number) {
    const existingMembers = await databaseServices.prisma.channelMember.findMany({
      where: { channelId, status: 'ACTIVE' },
      select: { userId: true }
    })
    const excludedUserIds = existingMembers.map((m) => m.userId)

    const keyword = search.trim()
    const userSearch = keyword
      ? {
          OR: [
            { username: { contains: keyword, mode: 'insensitive' as const } },
            { displayName: { contains: keyword, mode: 'insensitive' as const } },
            { fullName: { contains: keyword, mode: 'insensitive' as const } }
          ]
        }
      : {}

    const skip = (page - 1) * limit

    const where: any = {
      ...userSearch,
      OR: [
        {
          sentFriendRequests: {
            some: {
              addresseeId: userId,
              status: FriendStatus.ACCEPTED
            }
          }
        },
        {
          receivedFriendRequests: {
            some: {
              requesterId: userId,
              status: FriendStatus.ACCEPTED
            }
          }
        }
      ]
    }

    if (excludedUserIds.length) {
      where.id = { notIn: excludedUserIds }
    }

    const [users, total] = await Promise.all([
      databaseServices.prisma.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          displayName: true,
          avatar: true,
          fullName: true
        },
        orderBy: { username: 'asc' },
        skip,
        take: limit
      }),
      databaseServices.prisma.user.count({ where })
    ])

    const items = users.map((u) => ({
      id: u.id.toString(),
      username: u.username,
      displayName: u.displayName,
      avatar: u.avatar,
      fullName: u.fullName
    }))

    return {
      friends: items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  }

  async requestJoinChannel(channelId: bigint, userId: bigint) {
    const channel = await databaseServices.prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, workspaceId: true, isPrivate: true, type: true }
    })

    if (!channel || !channel.workspaceId) {
      throw new ErrorWithStatus({
        message: 'Channel không thuộc workspace nào',
        status: httpStatus.BAD_REQUESTED
      })
    }

    if (channel.type === ChannelType.DM) {
      throw new ErrorWithStatus({
        message: 'Không thể gửi yêu cầu tham gia DM channel',
        status: httpStatus.BAD_REQUESTED
      })
    }

    if (channel.isPrivate) {
      throw new ErrorWithStatus({
        message: 'Channel private chỉ có thể được mời, không thể tự xin vào',
        status: httpStatus.FORBIDDEN
      })
    }

    // Kiểm tra trạng thái member hiện tại
    const existing = await databaseServices.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })

    if (existing) {
      if (existing.status === MemberStatus.ACTIVE) {
        throw new ErrorWithStatus({
          message: 'Bạn đã là thành viên của channel này',
          status: httpStatus.BAD_REQUESTED
        })
      }
      if (existing.status === MemberStatus.PENDING_REQUEST) {
        throw new ErrorWithStatus({
          message: 'Bạn đã gửi yêu cầu tham gia channel này trước đó',
          status: httpStatus.BAD_REQUESTED
        })
      }
      if (existing.status === MemberStatus.PENDING_INVITE) {
        throw new ErrorWithStatus({
          message: 'Bạn đang có lời mời tham gia channel này, vui lòng phản hồi lời mời trước',
          status: httpStatus.BAD_REQUESTED
        })
      }
    }

    return await databaseServices.prisma.$transaction(async (tx) => {
      const workspaceMember = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: channel.workspaceId!, userId } }
      })

      if (!workspaceMember) {
        await tx.workspaceMember.create({
          data: {
            workspaceId: channel.workspaceId!,
            userId,
            role: WorkspaceMemberRole.MEMBER,
            status: MemberStatus.PENDING_REQUEST,
            joinedAt: new Date()
          }
        })
      } else if (workspaceMember.status !== MemberStatus.PENDING_REQUEST) {
        // Nếu đã có row nhưng status khác (LEFT / BANNED / ACTIVE ở workspace khác…)
        // → đồng bộ về PENDING_REQUEST cho khớp với channelMember.
        // Admin duyệt thành công sẽ update cả 2 về ACTIVE.
        await tx.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId: channel.workspaceId!, userId } },
          data: { status: MemberStatus.PENDING_REQUEST, role: WorkspaceMemberRole.MEMBER }
        })
      }

      // 2. Tạo / upsert channelMember với PENDING_REQUEST
      const channelMember = await tx.channelMember.upsert({
        where: { channelId_userId: { channelId, userId } },
        create: {
          channelId,
          userId,
          role: ChannelMemberRole.MEMBER,
          status: MemberStatus.PENDING_REQUEST,
          joinedAt: new Date()
        },
        update: {
          status: MemberStatus.PENDING_REQUEST
        }
      })

      return {
        channelId: channelMember.channelId.toString(),
        userId: channelMember.userId.toString(),
        status: MemberStatus.PENDING_REQUEST as string,
        createdAt: channelMember.joinedAt.toISOString()
      }
    })
  }

  async cancelJoinRequest(channelId: bigint, userId: bigint) {
    const existing = await databaseServices.prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })

    if (!existing) {
      throw new ErrorWithStatus({
        message: 'Không tìm thấy yêu cầu tham gia channel của bạn',
        status: httpStatus.NOTFOUND
      })
    }

    if (existing.status !== MemberStatus.PENDING_REQUEST) {
      throw new ErrorWithStatus({
        message: 'Chỉ có thể hủy yêu cầu khi đang ở trạng thái PENDING_REQUEST',
        status: httpStatus.BAD_REQUESTED
      })
    }

    await databaseServices.prisma.channelMember.delete({
      where: { channelId_userId: { channelId, userId } }
    })

    return {
      channelId: channelId.toString(),
      userId: userId.toString(),
      status: 'CANCELLED'
    }
  }
}

export default new ChannelService()
