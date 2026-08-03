import { Server } from 'socket.io'
import { Server as ServerHttp } from 'http'
import { verifyAccessToken } from '~/utils/utils'
import { TokenPayload } from '~/models/responses/user.responses'
import databaseServices from '~/services/database.services'
import { MessageType } from '~/constants/enum'
import { addSocket, getSocketIds, removeSocket } from '~/socket/online-users'
import { registerCallGateway } from '~/socket/call.gateway'

/**
 * socket = Kết nối cá nhân của 1 user. (Nên dùng socket.join là cầm tay duy nhất user đó dắt vào phòng).
   io = Máy chủ tổng (Server). (Nên dùng io.to(...).emit(...) là lệnh từ máy chủ tổng phát thanh xuống cho tất cả những user nào đang có mặt trong cái phòng đó).
 */

export const initialSocket = (httpSocket: ServerHttp) => {
  const io = new Server(httpSocket, {
    cors: {
      origin: ['http://localhost:5173'], // url của frontend
      methods: ['GET', 'POST', 'PUT', 'DELETE']
    }
  })

  // middleware socket cấp server
  // chạy mỗi khi client bắt đầu handshake/kết nối tới server (ngay trước khi sự kiện connection xảy ra). - chạy 1 lần cho 1 lần kết nối
  io.use(async (socket, next) => {
    try {
      const { Authorization } = socket.handshake.auth
      if (!Authorization || typeof Authorization !== 'string') return next(new Error('Unauthorized'))
      const parts = Authorization.split(' ')

      if (parts.length < 2) return next(new Error('Unauthorized'))
      const access_token = parts[1]

      // kiểm tra token hợp lệ không và tài khoản đã xác thực chưa
      const decode_authorization = await verifyAccessToken(access_token)

      socket.handshake.auth.decode_authorization = decode_authorization
      socket.handshake.auth.access_token = access_token
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

    addSocket(user_id, socket.id)
    console.log(`user ${user_id} connected with socket ${socket.id}, total sockets:`, getSocketIds(user_id).length)

    socket.use(async (packet, next) => {
      try {
        const { access_token } = socket.handshake.auth
        if (!access_token) return next(new Error('Unauthorized'))
        await verifyAccessToken(access_token)
        next()
      } catch (error) {
        next(new Error('Unauthorized')) // nếu lỗi nó bắt xuống sự kiện error bên dưới
      }
    })

    socket.on('error', (error) => {
      if (error.message === 'Unauthorized') {
        socket.disconnect()
      }
    })

    // Đăng ký call gateway (signaling cho Audio/Video call 1-1).
    // Gateway này tự quản lý cleanup khi socket disconnect.
    // registerCallGateway(io, socket)

    socket.on('join_channel', (channel_id) => {
      socket.join(channel_id.toString())
      console.log(`User ${user_id} joined channel ${channel_id}`)
    })

    socket.on('leave_channel', (channel_id) => {
      socket.leave(channel_id.toString())
      console.log(`User ${user_id} left channel ${channel_id}`)
    })

    socket.on('send_message', async (data) => {
      const res = await databaseServices.prisma.message.create({
        data: {
          channelId: Number(data.channel_id),
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

      io.to(data.channel_id.toString()).emit('receive_message', res)
    })

    socket.on('send_gif', async (data) => {
      const { channel_id, file_name, file_url, mime_type, file_size } = data

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

      io.to(data.channel_id.toString()).emit('receive_message', res)
    })

    // sự kiện mặc định của socket server - nếu ngắt kết nối (client ngắt, đóng tab) -> nó chạy
    socket.on('disconnect', () => {
      removeSocket(socket.id)
      console.log(
        `socket ${socket.id} disconnected for user ${user_id}, remaining sockets:`,
        getSocketIds(user_id).length
      )
    })
  })
}
