import { Server, Socket } from 'socket.io'
import { ChannelType, MemberStatus, MessageType } from '~/constants/enum'
import { Media } from '~/models/responses/media.response'
import databaseServices from '~/services/database.services'
import userServices from '~/services/user.services'
import { envConfig } from '~/utils/config'
import { verifyToken } from '~/utils/jwt'
import {
  getChannelLatestMessageId,
  getChannelMemberIds,
  getChannelType,
  getChannelWorkspaceId,
  invalidateChannelLatestMessage
} from '~/services/redis.services'
import { TokenExpiredError } from 'jsonwebtoken'
import { enqueueUnread } from '~/queues/unread.aggregator'
import { incrementUnreadBatch, markChannelActive, resetUnread, setUnreadCount } from '~/services/unread.services'

export const Socket_Room = {
  user: (userId: string) => `user:${userId}`,
  workspace: (workspaceId: string) => `workspace:${workspaceId}`,
  channel: (channelId: string) => `channel:${channelId}`
}

// cập nhật trạng thái đã đọc tin nhắn của user trong channel
export const upsertChannelReadState = async (
  userId: number,
  channelId: number,
  lastReadMessageId?: number
): Promise<string | null> => {
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

  await resetUnread(channelId, userId)

  return latestMessageId === null ? null : latestMessageId.toString()
}

export const upsertSenderReadState = async (userId: number, channelId: number, messageId: number) => {
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
      lastReadMessageId: BigInt(messageId),
      lastReadAt: new Date()
    },
    update: {
      lastReadMessageId: BigInt(messageId),
      lastReadAt: new Date()
    }
  })
}

/**
 * Đánh dấu đã đọc tới 1 message cụ thể (dùng cho event `mark_read`).
 *
 * Mục đích: giữ cho Redis count + DB lastReadMessageId khớp với thứ user
 * THỰC SỰ đang xem (fix badge sai ở tab phụ / thiết bị khác).
 *
 * - Không hồi quy: nếu DB đang ở message mới hơn thì giữ nguyên.
 * - Count lấy từ DB (nguồn sự thật) → không bao giờ xoá mất unread của
 *   các tin gửi sau đó.
 */
export const markReadToMessage = async (userId: number, channelId: number, messageId: number): Promise<boolean> => {
  const targetId = BigInt(messageId)

  // 1. Lấy state hiện tại → không bao giờ đi lùi mốc đọc.
  const current = await databaseServices.prisma.channelReadState.findUnique({
    where: {
      userId_channelId: {
        userId,
        channelId
      }
    },
    select: { lastReadMessageId: true }
  })

  const currentId = current?.lastReadMessageId ?? BigInt(0)
  const newReadId = targetId > currentId ? targetId : currentId

  // 2. Chốt read state vào DB (reconcile worker dựa vào cột này).
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
      lastReadMessageId: newReadId,
      lastReadAt: new Date()
    },
    update: {
      lastReadMessageId: newReadId,
      lastReadAt: new Date()
    }
  })

  // 3. Tính count.
  //    Fast path (99%): message vừa đọc là mới nhất của channel → count = 0.
  //    → chỉ 1 lệnh Redis đọc cache, KHÔNG query DB.
  const latestMessageId = await getChannelLatestMessageId(channelId.toString())

  if (latestMessageId === null || newReadId >= latestMessageId) {
    await resetUnread(channelId, userId)
    return true
  }

  //    Slow path (hiếm): có tin gửi sau tin vừa đọc → tính chính xác từ DB
  //    để không xoá mất unread của các tin đó.
  const count = await databaseServices.prisma.message.count({
    where: {
      channelId: BigInt(channelId),
      id: { gt: newReadId },
      messageType: { not: MessageType.CONFIG }
    }
  })

  await setUnreadCount(channelId, userId, count)

  return count === 0
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
/**
 * Tăng unread counter cho tất cả member của channel (trừ người gửi).
 *
 * Guard CONFIG: message type CONFIG là message hệ thống (đổi tên channel,
 * đổi ảnh bìa...) → không tính vào unread.
 */
const incrementUnreadForChannel = async (
  channelId: number,
  senderId: number,
  messageType: MessageType
): Promise<void> => {
  if (messageType === MessageType.CONFIG) return

  // Member list lấy từ cache Redis (TTL 5 phút) → 0 query DB trên đường nóng.
  const members = await getChannelMemberIds(channelId.toString())
  const recipients = members.filter((member) => member !== senderId)

  // 1 pipeline = 1 round trip cho toàn bộ recipients.
  await incrementUnreadBatch(channelId, recipients)

  await markChannelActive(channelId)
}

// Preview sidebar DM — bắn tới room `user:{id}` của mọi member (gồm cả sender),
// chỉ áp dụng cho channel DM. Không filter đang mở hay không, client tự upsert theo id.
const emitReceiveMessageGlobal = async (io: Server, channelId: number, channelType: ChannelType, payload: unknown) => {
  if (channelType !== ChannelType.DM) return

  const messageType = (payload as { messageType?: MessageType })?.messageType
  if (messageType === MessageType.CONFIG) return

  const members = await getChannelMemberIds(channelId.toString())
  for (const m of members) {
    io.to(Socket_Room.user(String(m))).emit('receive_message_global', payload)
  }
}

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

  // Cache latest message đã cũ (vừa có message mới) → xoá để lần đọc sau
  await invalidateChannelLatestMessage(channelId)

  await incrementUnreadForChannel(channelId, userId, data.message_type)

  // Người gửi chắc chắn đang đọc channel này → chốt mốc đọc + reset count + báo tab khác.
  await upsertSenderReadState(userId, channelId, Number(res.id))
  await resetUnread(channelId, userId)
  io.to(Socket_Room.user(String(userId))).emit('channel_read', {
    channelId: String(channelId),
    messageId: String(res.id)
  })

  io.to(Socket_Room.channel(channelId.toString())).emit('receive_message', response)

  const workspaceId = await getChannelWorkspaceId(channelId.toString())
  const channelType = await getChannelType(channelId.toString())
  if (channelType === null) return

  await emitReceiveMessageGlobal(io, channelId, channelType, response)

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

  // Cache latest message đã cũ (vừa có message mới) → xoá để lần đọc sau
  await invalidateChannelLatestMessage(channelId)

  // Tăng unread counter Redis (Phase 3) — GIF cũng là tin nhắn, tính unread.
  await incrementUnreadForChannel(channelId, userId, MessageType.GIF)

  // Người gửi chắc chắn đang đọc channel này → chốt mốc đọc + reset count + báo tab khác.
  await upsertSenderReadState(userId, channelId, Number(res.id))
  await resetUnread(channelId, userId)
  io.to(Socket_Room.user(String(userId))).emit('channel_read', {
    channelId: String(channelId),
    messageId: String(res.id)
  })

  io.to(Socket_Room.channel(channelId.toString())).emit('receive_message', res)
  io.to(Socket_Room.channel(channelId.toString())).emit('receive_attachments', res.attachments)

  const workspaceId = await getChannelWorkspaceId(channelId.toString())

  const channelType = await getChannelType(channelId.toString())
  if (channelType === null) return

  await emitReceiveMessageGlobal(io, channelId, channelType, { ...res, content: 'Đã gửi một GIF' })

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
