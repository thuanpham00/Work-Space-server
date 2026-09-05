/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { Server, Socket } from 'socket.io'
import { MessageType } from '~/constants/enum'
import { Media } from '~/models/responses/media.response'
import databaseServices from '~/services/database.services'
import userServices from '~/services/user.services'
import { envConfig } from '~/utils/config'
import { verifyToken } from '~/utils/jwt'

export const Socket_Room = {
  user: (userId: string) => `user:${userId}`,
  workspace: (workspaceId: string) => `workspace:${workspaceId}`,
  channel: (channelId: string) => `channel:${channelId}`
}

// cập nhật trạng thái đã đọc tin nhắn của user trong channel
export const upsertChannelReadState = async (userId: number, channelId: number, lastReadMessageId?: number) => {
  const latestMessageId =
    lastReadMessageId ??
    (
      await databaseServices.prisma.message.findFirst({
        where: { channelId },
        orderBy: { id: 'desc' },
        select: { id: true }
      })
    )?.id

  await databaseServices.prisma.channelReadState.upsert({
    where: {
      userId_channelId: {
        userId,
        channelId
      }
    },
    create: {
      userId,
      channelId,
      lastReadMessageId: latestMessageId,
      lastReadAt: new Date()
    },
    update: {
      lastReadMessageId: latestMessageId,
      lastReadAt: new Date()
    }
  })
}

// xử lý bắn socket tới những user (trừ người gửi) thuộc channel đó nhưng không join vào channel đó
export const emitUnreadChannel = async (
  io: Server,
  params: {
    channelId: number
    senderId: number
    latestMessageId: number
  }
) => {
  const { channelId, senderId, latestMessageId } = params
  const channel = await databaseServices.prisma.channel.findFirst({
    where: {
      id: channelId
    },
    select: { workspaceId: true }
  })

  if (!channel) return

  const members = await databaseServices.prisma.channelMember.findMany({
    where: {
      channelId: channelId,
      userId: {
        not: senderId
      }
    },
    select: { userId: true }
  })

  for (const member of members) {
    io.to(Socket_Room.user(member.userId.toString())).emit('channel_unread', {
      channelId,
      workspaceId: channel.workspaceId,
      latestMessageId
    })
  }
}

// làm mới access token bằng refresh token
export const handleRefreshToken = async (refresh_token: string, socket: Socket, next: (err?: any) => void) => {
  try {
    const [decode_refreshToken, findToken] = await Promise.all([
      verifyToken({ token: refresh_token, privateKey: envConfig.secret_key_refresh_token }),
      databaseServices.prisma.refreshToken.findUnique({
        where: { token: refresh_token }
      })
    ])

    if (findToken) {
      // Tạo tokens mới
      const { accessToken, refreshToken: newRefreshToken } = await userServices.refreshToken({
        token: refresh_token,
        user_id: decode_refreshToken.user_id,
        exp: decode_refreshToken.exp
      })
      // Cập nhật socket auth với token mới
      socket.handshake.auth.access_token = accessToken
      socket.handshake.auth.refresh_token = newRefreshToken

      // Gửi tokens mới về client
      socket.emit('token_refresh', {
        accessToken,
        refreshToken: newRefreshToken
      })
      next() // Cho phép event tiếp tục với token mới
      return
    }
  } catch (error) {
    // nếu refreshToken hết hạn thì bắn lên client cho logout
    // sau đó disconnect
    socket.emit('auth_error', {
      message: 'Unauthorized',
      name: 'UnauthorizedError',
      code: 401,
      type: 'refresh_token_expired',
      refreshToken: refresh_token
    })
    next(new Error('Unauthorized'))
  }
}

// xử lý gửi tin nhắn
export const handleSendMessage = async (
  io: Server,
  params: {
    userId: number
    user_id: string
    data: {
      channel_id: string | number
      content: string
      message_type: MessageType
      files: Media[]
    }
  }
) => {
  const { userId, user_id, data } = params
  const channelId = Number(data.channel_id)
  const isFiles = data.files.length > 0

  const res = await databaseServices.prisma.message.create({
    data: {
      channelId,
      senderId: Number(user_id),
      content: data.content,
      messageType: data.message_type,
      createdAt: new Date(),
      updatedAt: new Date()
    },
    include: {
      sender: true
    }
  })

  let attachments: Awaited<ReturnType<typeof databaseServices.prisma.attachment.createManyAndReturn>> = []

  if (isFiles) {
    const files = data.files.map((f: Media) => ({
      messageId: res.id,
      fileName: f.name,
      fileUrl: f.url,
      mimeType: f.type,
      fileSize: f.size,
      createdAt: new Date()
    }))
    attachments = await databaseServices.prisma.attachment.createManyAndReturn({
      data: files
    })

    io.to(Socket_Room.channel(channelId.toString())).emit('receive_attachments', attachments)
  }

  const response = {
    ...res,
    attachments
  }

  io.to(Socket_Room.channel(channelId.toString())).emit('receive_message', response)

  await emitUnreadChannel(io, {
    channelId,
    senderId: userId,
    latestMessageId: Number(res.id)
  })
}

// xử lý gửi gif
export const handleSendGif = async (
  io: Server,
  params: {
    userId: number
    user_id: string
    data: {
      channel_id: string | number
      file_name: string
      file_url: string
      mime_type: string
      file_size: string | number
    }
  }
) => {
  const { userId, user_id, data } = params
  const channelId = Number(data.channel_id)

  const res = await databaseServices.prisma.message.create({
    data: {
      channelId,
      senderId: Number(user_id),
      content: '',
      messageType: MessageType.GIF,
      createdAt: new Date(),
      updatedAt: new Date(),
      attachments: {
        create: {
          fileName: data.file_name,
          fileUrl: data.file_url,
          mimeType: data.mime_type,
          fileSize: Number(data.file_size),
          createdAt: new Date()
        }
      }
    },
    include: {
      sender: true,
      attachments: true
    }
  })

  io.to(Socket_Room.channel(channelId.toString())).emit('receive_message', res)
  io.to(Socket_Room.channel(channelId.toString())).emit('receive_attachments', res.attachments)

  await emitUnreadChannel(io, {
    channelId,
    senderId: userId,
    latestMessageId: Number(res.id)
  })
}
