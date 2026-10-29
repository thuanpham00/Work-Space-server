import { Server } from 'socket.io'
import { Server as ServerHttp } from 'http'
import { checkAccessToken, verifyAccessToken } from '~/utils/utils'
import { TokenPayload } from '~/models/responses/user.responses'
import databaseServices from '~/services/database.services'
import {
  handleRefreshToken,
  handleSendGif,
  handleSendMessage,
  isMemberChannel,
  Socket_Room,
  upsertChannelReadState
} from '~/socket/utils'
import { initRedisAdapter } from '~/socket/redis.adapter'
import { setUserOffline, setUserOnline } from '~/services/presence.services'
import { setIO } from '~/socket/socket-instance'
import { envConfig } from '~/utils/config'

/**
 * socket = Kết nối cá nhân của 1 user. (Nên dùng socket.join là cầm tay duy nhất user đó dắt vào phòng).
   io = Máy chủ tổng (Server). (Nên dùng io.to(...).emit(...) là lệnh từ máy chủ tổng phát thanh xuống cho tất cả những user nào đang có mặt trong cái phòng đó).
 */

export let io: Server | null = null

export { Socket_Room }

export const initialSocket = async (httpSocket: ServerHttp) => {
  io = new Server(httpSocket, {
    cors: {
      origin: [envConfig.frontend_url], // url của frontend
      methods: ['GET', 'POST', 'PUT', 'DELETE']
    }
  })
  // Adapter phải attach TRƯỚC khi đăng ký handler, để mọi emit đi qua Redis pub/sub.
  // Nếu attach sau, các emit đầu tiên chỉ đi local → instance khác không nhận được.
  await initRedisAdapter(io)

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

    // next() trong middleware socket khác next() trong middleware http // lỗi ở đây nó bắn về socket.on('error')
    socket.use(async (_, next) => {
      const { access_token, refresh_token } = socket.handshake.auth
      if (!access_token) return next(new Error('Unauthorized'))

      const tokenStatus = await checkAccessToken(access_token)
      if (tokenStatus === 'valid') {
        return next()
      }

      if (tokenStatus === 'invalid' || !refresh_token) {
        return next(new Error('Unauthorized'))
      }

      const refreshed = await handleRefreshToken(refresh_token, socket)

      return refreshed.ok ? next() : next(new Error('Unauthorized'))
    })

    socket.on('error', (error) => {
      if (error.message === 'Unauthorized') {
        socket.disconnect()
      }
    })

    // đánh dấu online trong Redis
    await setUserOnline(userId, socket.id)

    socket.on('heartbeat', async () => {
      await setUserOnline(userId, socket.id)
    })

    socket.on('join_channel', async (channel_id) => {
      const channelId = channel_id.toString()
      const isMember = await isMemberChannel(userId, Number(channelId))
      if (!isMember) return

      if (activeChannelId && activeChannelId !== null) {
        socket.leave(Socket_Room.channel(activeChannelId))
      }

      socket.join(Socket_Room.channel(channelId))
      activeChannelId = channelId

      await upsertChannelReadState(userId, Number(channelId))
    })

    socket.on('leave_channel', async (channel_id) => {
      const channelId = channel_id.toString()

      if (activeChannelId === channelId) {
        activeChannelId = null
      }

      socket.leave(Socket_Room.channel(channelId))
    })

    socket.on('send_message', async (data) => {
      const isMember = await isMemberChannel(userId, Number(data.channel_id))
      if (!isMember) return

      await handleSendMessage(io as Server, { userId, user_id, data })
    })

    socket.on('send_gif', async (data) => {
      const isMember = await isMemberChannel(userId, Number(data.channel_id))
      if (!isMember) return

      await handleSendGif(io as Server, { userId, user_id, data })
    })

    // sự kiện mặc định của socket server - nếu ngắt kết nối (client ngắt, đóng tab) -> nó chạy
    socket.on('disconnect', async () => {
      await setUserOffline(userId, socket.id)
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
  })

  setIO(io)
}
