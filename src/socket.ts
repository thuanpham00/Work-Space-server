/* eslint-disable no-useless-assignment */
import { Server, Socket } from 'socket.io'
import { Server as ServerHttp } from 'http'
import { verifyAccessToken } from '~/utils/utils'
import { TokenPayload } from '~/models/responses/user.responses'
import databaseServices from '~/services/database.services'
import { MessageType } from '~/constants/enum'
import { addSocket, getSocketIds, removeSocket } from '~/socket/online-users'
import { Media } from '~/models/responses/media.response'
import { verifyToken } from '~/utils/jwt'
import { envConfig } from '~/utils/config'
import userService from '~/services/user.services'

/**
 * socket = Kết nối cá nhân của 1 user. (Nên dùng socket.join là cầm tay duy nhất user đó dắt vào phòng).
   io = Máy chủ tổng (Server). (Nên dùng io.to(...).emit(...) là lệnh từ máy chủ tổng phát thanh xuống cho tất cả những user nào đang có mặt trong cái phòng đó).
 */

export let io: Server | null = null

export const Socket_Room = {
  user: (userId: string) => `user:${userId}`,
  workspace: (workspaceId: string) => `workspace:${workspaceId}`,
  channel: (channelId: string) => `channel:${channelId}`
}

const upsertChannelReadState = async (userId: number, channelId: number, lastReadMessageId?: number) => {
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
const emitUnreadChannel = async (
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

const handleRefreshToken = async (refresh_token: string, socket: Socket, next: (err?: any) => void) => {
  try {
    const [decode_refreshToken, findToken] = await Promise.all([
      verifyToken({ token: refresh_token, privateKey: envConfig.secret_key_refresh_token }),
      databaseServices.prisma.refreshToken.findUnique({
        where: { token: refresh_token }
      })
    ])

    if (findToken) {
      // Tạo tokens mới
      const { accessToken, refreshToken: newRefreshToken } = await userService.refreshToken({
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

export const initialSocket = (httpSocket: ServerHttp) => {
  io = new Server(httpSocket, {
    cors: {
      origin: ['http://localhost:5173'], // url của frontend
      methods: ['GET', 'POST', 'PUT', 'DELETE']
    }
  })

  // middleware socket cấp server
  // chạy mỗi khi client bắt đầu handshake/kết nối tới server (ngay trước khi sự kiện connection xảy ra). - chạy 1 lần cho 1 lần kết nối
  io.use(async (socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie
      const refresh_token = cookieHeader
        ?.split('; ')
        .find((row) => row.startsWith('refresh_token='))
        ?.split('=')[1]

      const { Authorization } = socket.handshake.auth
      if (!Authorization || typeof Authorization !== 'string') return next(new Error('Unauthorized'))
      const parts = Authorization.split(' ')

      if (parts.length < 2) return next(new Error('Unauthorized'))
      const access_token = parts[1]

      // kiểm tra token hợp lệ không và tài khoản đã xác thực chưa
      const decode_authorization = await verifyAccessToken(access_token)

      socket.handshake.auth.decode_authorization = decode_authorization
      socket.handshake.auth.access_token = access_token
      socket.handshake.auth.refresh_token = refresh_token
      next()
    } catch (error) {
      next({
        message: 'Unauthorized',
        name: 'UnauthorizedError',
        data: error
      }) // đúng kiểu dữ liệu mặc định của io.use
    }
  })

  // sự kiện mặc định của socket server - tự động chạy khi có connect từ client tới
  io.on('connection', async (socket) => {
    const { user_id } = socket.handshake.auth.decode_authorization as TokenPayload
    const userId = Number(user_id)
    // Channel đang mở trên socket này (chỉ join 1 channel tại 1 thời điểm)
    let activeChannelId: string | null = null

    addSocket(user_id, socket.id)

    socket.use(async (packet, next) => {
      try {
        const { access_token } = socket.handshake.auth
        if (!access_token) return next(new Error('Unauthorized'))
        try {
          await verifyAccessToken(access_token)
          next()
        } catch (error: any) {
          if (error.message === 'AccessToken expired') {
            const refresh_token = socket.handshake.auth.refresh_token

            if (refresh_token) {
              await handleRefreshToken(refresh_token, socket, next)
            } else {
              next(new Error('Unauthorized'))
            }
          }
          next(new Error('Unauthorized'))
        }
      } catch (error) {
        next(new Error('Unauthorized')) // nếu lỗi nó bắt xuống sự kiện error bên dưới
      }
    })

    socket.on('error', (error) => {
      if (error.message === 'Unauthorized') {
        socket.disconnect()
      }
    })

    socket.on('join_channel', async (channel_id) => {
      const channelId = channel_id.toString()

      if (activeChannelId && activeChannelId !== null) {
        socket.leave(Socket_Room.channel(activeChannelId))
      }

      socket.join(Socket_Room.channel(channelId))
      activeChannelId = channelId

      console.log(`user ${user_id} joined channel ${channelId}`)
      await upsertChannelReadState(userId, Number(channelId))
    })

    socket.on('leave_channel', (channel_id) => {
      const channelId = channel_id.toString()

      if (activeChannelId === channelId) {
        activeChannelId = null
      }

      socket.leave(Socket_Room.channel(channelId))
    })

    socket.on('send_message', async (data) => {
      const channelId = Number(data.channel_id)
      const isFiles = data.files.length > 0 ? true : false
      let response = {}

      const res = await databaseServices.prisma.message.create({
        data: {
          channelId: channelId,
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

      response = {
        ...res,
        attachments: []
      }

      if (isFiles) {
        const files = data.files.map((f: Media) => {
          return {
            messageId: res.id,
            fileName: f.name,
            fileUrl: f.url,
            mimeType: f.type,
            fileSize: f.size,
            createdAt: new Date()
          }
        })
        const filesRes = await databaseServices.prisma.attachment.createManyAndReturn({
          data: files
        })

        response = {
          ...res,
          attachments: filesRes
        }

        io?.to(Socket_Room.channel(channelId.toString())).emit('receive_attachments', filesRes) // đồng bộ attachments lên client
      }

      io?.to(Socket_Room.channel(channelId.toString())).emit('receive_message', response)

      await emitUnreadChannel(io as Server, {
        channelId,
        senderId: userId,
        latestMessageId: Number(res.id)
      })
    })

    socket.on('send_gif', async (data) => {
      const { channel_id, file_name, file_url, mime_type, file_size } = data
      const channelId = channel_id.toString()

      const res = await databaseServices.prisma.message.create({
        data: {
          channelId: Number(channel_id),
          senderId: Number(user_id),
          content: '',
          messageType: MessageType.GIF,
          createdAt: new Date(),
          updatedAt: new Date(),
          attachments: {
            create: {
              fileName: file_name,
              fileUrl: file_url,
              mimeType: mime_type,
              fileSize: Number(file_size),
              createdAt: new Date()
            }
          }
        },
        include: {
          sender: true,
          attachments: true
        }
      })

      io?.to(data.channel_id.toString()).emit('receive_message', res)
      io?.to(data.channel_id.toString()).emit('receive_attachments', res.attachments) // đồng bộ attachments lên client

      await emitUnreadChannel(io as Server, {
        channelId,
        senderId: userId,
        latestMessageId: Number(res.id)
      })
    })

    // sự kiện mặc định của socket server - nếu ngắt kết nối (client ngắt, đóng tab) -> nó chạy
    socket.on('disconnect', () => {
      removeSocket(socket.id)
      console.log(
        `socket ${socket.id} disconnected for user ${user_id}, remaining sockets:`,
        getSocketIds(user_id).length
      )
    })

    // join room user
    socket.join(Socket_Room.user(user_id))

    const workspaceMembers = await databaseServices.prisma.workspaceMember.findMany({
      where: { userId },
      select: { workspaceId: true }
    })

    // join room workspace
    for (const member of workspaceMembers) {
      socket.join(Socket_Room.workspace(member.workspaceId.toString()))
    }

    console.log(`user ${user_id} joined rooms: user + ${workspaceMembers.length} workspace(s)`)
  })
}
