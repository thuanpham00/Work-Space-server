/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Server } from 'socket.io'
import { Server as ServerHttp } from 'http'
import { verifyAccessToken } from '~/utils/utils'
import { TokenPayload } from '~/models/responses/user.responses'
import databaseServices from '~/services/database.services'
import { addSocket, getSocketIds, removeSocket } from '~/socket/online-users'
import {
  handleRefreshToken,
  handleSendGif,
  handleSendMessage,
  Socket_Room,
  upsertChannelReadState
} from '~/socket/utils'

/**
 * socket = Kết nối cá nhân của 1 user. (Nên dùng socket.join là cầm tay duy nhất user đó dắt vào phòng).
   io = Máy chủ tổng (Server). (Nên dùng io.to(...).emit(...) là lệnh từ máy chủ tổng phát thanh xuống cho tất cả những user nào đang có mặt trong cái phòng đó).
 */

export let io: Server | null = null

export { Socket_Room }

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

    socket.use(async (_, next) => {
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
      } catch (error: any) {
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
      await handleSendMessage(io as Server, { userId, user_id, data })
    })

    socket.on('send_gif', async (data) => {
      await handleSendGif(io as Server, { userId, user_id, data })
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
