import { Server, Socket } from 'socket.io'
import { MemberStatus, MessageType } from '~/constants/enum'
import { Media } from '~/models/responses/media.response'
import databaseServices from '~/services/database.services'
import userServices from '~/services/user.services'
import { envConfig } from '~/utils/config'
import { verifyToken } from '~/utils/jwt'
import {
  getChannelLatestMessageId,
  getChannelType,
  getChannelWorkspaceId,
  invalidateChannelLatestMessage
} from '~/services/redis.services'
import { TokenExpiredError } from 'jsonwebtoken'
import { enqueueUnread } from '~/queues/unread.aggregator'

export const Socket_Room = {
  user: (userId: string) => `user:${userId}`,
  workspace: (workspaceId: string) => `workspace:${workspaceId}`,
  channel: (channelId: string) => `channel:${channelId}`
}

// cập nhật trạng thái đã đọc tin nhắn của user trong channel
export const upsertChannelReadState = async (userId: number, channelId: number, lastReadMessageId?: number) => {
  const latestMessageId = lastReadMessageId ?? (await getChannelLatestMessageId(channelId.toString()))

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

// làm mới access token bằng refresh token
export type RefreshResult = { ok: true } | { ok: false; reason: 'expired' | 'invalid' }
export const handleRefreshToken = async (refresh_token: string, socket: Socket): Promise<RefreshResult> => {
  try {
    const [decode_refreshToken, findToken] = await Promise.all([
      verifyToken({ token: refresh_token, privateKey: envConfig.secret_key_refresh_token }),
      databaseServices.prisma.refreshToken.findUnique({
        where: { token: refresh_token }
      })
    ])

    if (!findToken) {
      socket.emit('auth_error', {
        message: 'Unauthorized',
        name: 'UnauthorizedError',
        code: 401,
        type: 'refresh_token_expired',
        refreshToken: refresh_token
      })
      return { ok: false, reason: 'invalid' }
    }

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
    return { ok: true }
  } catch (error) {
    // nếu refreshToken hết hạn thì bắn lên client cho logout
    // sau đó disconnect
    if (error instanceof TokenExpiredError) {
      socket.emit('auth_error', {
        message: 'Unauthorized',
        name: 'UnauthorizedError',
        code: 401,
        type: 'refresh_token_expired',
        refreshToken: refresh_token
      })
      return { ok: false, reason: 'expired' }
    }
    return { ok: false, reason: 'invalid' }
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

  // Cache latest message đã cũ (vừa có message mới) → xoá để lần đọc sau
  // query lại từ DB, tránh chốt read state sai.
  await invalidateChannelLatestMessage(channelId)

  const workspaceId = await getChannelWorkspaceId(channelId.toString())

  const channelType = await getChannelType(channelId.toString())
  if (channelType === null) return

  enqueueUnread({
    channelId,
    workspaceId,
    senderId: userId,
    messageId: Number(res.id),
    createdAt: new Date().toISOString(),
    type: channelType
  }).catch((err) => console.error('[enqueueUnread]', err))
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

  // Cache latest message đã cũ (vừa có message mới) → xoá để lần đọc sau
  // query lại từ DB, tránh chốt read state sai.
  await invalidateChannelLatestMessage(channelId)

  const workspaceId = await getChannelWorkspaceId(channelId.toString())

  const channelType = await getChannelType(channelId.toString())
  if (channelType === null) return

  enqueueUnread({
    channelId,
    workspaceId,
    senderId: userId,
    messageId: Number(res.id),
    createdAt: new Date().toISOString(),
    type: channelType
  }).catch((err) => console.error('[enqueueUnread]', err))
}

export const isMemberChannel = async (userId: number, channelId: number): Promise<boolean> => {
  const member = await databaseServices.prisma.channelMember.findUnique({
    where: {
      channelId_userId: {
        channelId: BigInt(channelId),
        userId: BigInt(userId)
      }
    },
    select: { status: true }
  })
  return member?.status === MemberStatus.ACTIVE
}
