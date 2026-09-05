/* eslint-disable @typescript-eslint/no-explicit-any */
import { configChannel } from '~/constants/channel'
import { ChannelType, FriendStatus, FriendStatusRequest } from '~/constants/enum'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import databaseServices from '~/services/database.services'

class FriendService {
  async getAllFriends(userId: bigint, status: string, search: string) {
    const keyword = search.trim()

    const userSearch = keyword
      ? {
          OR: [
            {
              username: {
                contains: keyword,
                mode: 'insensitive' as const
              }
            },
            {
              displayName: {
                contains: keyword,
                mode: 'insensitive' as const
              }
            },
            {
              fullName: {
                contains: keyword,
                mode: 'insensitive' as const
              }
            }
          ]
        }
      : undefined

    let where: any

    switch (status) {
      case FriendStatusRequest.REQUEST_SENT:
        where = {
          requesterId: userId,
          status: FriendStatus.PENDING,
          ...(userSearch && {
            addressee: userSearch
          })
        }
        break

      case FriendStatusRequest.REQUEST_RECEIVED:
        where = {
          addresseeId: userId,
          status: FriendStatus.PENDING,
          ...(userSearch && {
            requester: userSearch
          })
        }
        break

      default:
        where = {
          status: FriendStatus.ACCEPTED,
          OR: [
            {
              requesterId: userId,
              ...(userSearch && {
                addressee: userSearch
              })
            },
            {
              addresseeId: userId,
              ...(userSearch && {
                requester: userSearch
              })
            }
          ]
        }
        break
    }

    const friends = await databaseServices.prisma.friend.findMany({
      where,
      orderBy: {
        createdAt: 'desc'
      },
      include: {
        requester: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true,
            status: true,
            fullName: true,
            createdAt: true
          }
        },
        addressee: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true,
            status: true,
            fullName: true,
            createdAt: true
          }
        }
      }
    })

    return friends.map((friend) => {
      const user = friend.requesterId === userId ? friend.addressee : friend.requester

      return {
        ...user,
        id: user.id.toString(),
        createdAt: user.createdAt.toISOString()
      }
    })
  }

  async getUnreadFriends(userId: bigint) {
    // lấy những channel (ko có workspace - channel DM) mà user tham gia và check unreadState
    const channelList = await databaseServices.prisma.channelMember.findMany({
      where: {
        userId: userId,
        channel: {
          workspace: null,
          type: ChannelType.DM
        }
      },
      select: {
        channelId: true
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
        lastReadMessageId: true
      }
    })

    for (const readChannelState of readChannelStates) {
      const key = readChannelState.channelId.toString()
      if (!readChannelStateMap.has(key)) {
        readChannelStateMap.set(key, readChannelState.lastReadMessageId)
      }
    }

    const lastMessage = await databaseServices.prisma.message.findMany({
      where: {
        channelId: { in: channelIds }
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

    return channelIds.map((channelId) => {
      const key = channelId.toString()
      const readChannelState = readChannelStateMap.get(key)
      const lastMessageState = lastMessageMap.get(key)

      return {
        channelId,
        lastMessageId: lastMessageState,
        unread: lastMessageState !== null && readChannelState !== lastMessageState
      }
    })
  }

  async addFriend(userId: bigint, friendId: bigint) {
    const existing = await databaseServices.prisma.friend.findFirst({
      where: {
        requesterId: userId,
        addresseeId: friendId,
        status: FriendStatus.PENDING
      }
    })

    if (existing) {
      // // nếu đã tồn tại người A gửi người B thì lúc này sẽ hủy kết bạn, xóa đi lời mời này - xóa friend
      await databaseServices.prisma.friend.delete({
        where: {
          id: existing.id
        }
      })
      return
    }
    await databaseServices.prisma.friend.create({
      data: {
        requesterId: userId,
        addresseeId: friendId,
        status: FriendStatus.PENDING
      }
    })
  }

  async acceptFriend(userId: bigint, friendId: bigint) {
    const friendRequest = await databaseServices.prisma.friend.findFirst({
      where: {
        requesterId: friendId,
        addresseeId: userId,
        status: FriendStatus.PENDING
      }
    })

    if (!friendRequest) {
      throw new ErrorWithStatus({
        message: 'Không tìm thấy yêu cầu kết bạn',
        status: httpStatus.NOTFOUND
      })
    }

    await databaseServices.prisma.friend.update({
      where: {
        id: friendRequest.id
      },
      data: {
        status: FriendStatus.ACCEPTED,
        acceptedAt: new Date()
      }
    })

    // tạo channels và channel_members cho phòng chat 2 người
    await databaseServices.prisma.channel.create({
      data: {
        name: 'Direct Messages',
        type: ChannelType.DM,
        description: 'Phòng chat riêng tư',
        isPrivate: true,
        config: {
          create: {
            accent: configChannel.defaultAccent,
            backgroundUrl: '',
            backgroundColor: configChannel.defaultBackgroundColor
          }
        }, // tạo config cho channel
        nicknames: {
          create: [
            {
              userId: userId,
              nickname: ''
            },
            {
              userId: friendId,
              nickname: ''
            }
          ]
        }, // tạo nicknames cho channel
        members: {
          create: [
            {
              userId: userId,
              joinedAt: new Date()
            },
            {
              userId: friendId,
              joinedAt: new Date()
            }
          ]
        } // tạo members cho channel
      }
    })
  }

  async rejectFriend(userId: bigint, friendId: bigint) {
    const friendRequest = await databaseServices.prisma.friend.findFirst({
      where: {
        requesterId: friendId,
        addresseeId: userId,
        status: FriendStatus.PENDING
      }
    })

    if (!friendRequest) {
      throw new ErrorWithStatus({
        message: 'Không tìm thấy yêu cầu kết bạn',
        status: httpStatus.NOTFOUND
      })
    }

    await databaseServices.prisma.friend.delete({
      where: {
        id: friendRequest.id
      }
    })
  }
}

export default new FriendService()
