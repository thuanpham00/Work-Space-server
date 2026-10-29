/* eslint-disable @typescript-eslint/no-explicit-any */
import express from 'express'
import { config } from 'dotenv'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import cors from 'cors'
import { createServer } from 'http'
import databaseServices from '~/services/database.services'
import cookieParse from 'cookie-parser'
import userRoutes from '~/routes/user.routes'
import friendRoutes from '~/routes/friend.routes'
import channelRoutes from '~/routes/channel.routes'
import workspaceRoutes from '~/routes/workspace.routes'
import channelInviteRoutes from '~/routes/channelInvite.routes'
import socketRoutes from '~/routes/socket.routes'
import searchRoutes from '~/routes/search.routes'
import { errorHandler } from '~/middlewares/errorHandler.middlewares'
import { initialSocket } from '~/socket/socket'
import { closeRedisAdapter } from '~/socket/redis.adapter'
import { cleanupIdlePresence } from '~/services/presence.services'
import { startUnreadWorker } from '~/queues/unread.worker'
import { startUnreadAggregator } from '~/queues/unread.aggregator'
import { envConfig } from '~/utils/config'
config()

// Sửa lỗi BigInt không thể JSON.stringify được
;(BigInt.prototype as any).toJSON = function () {
  return this.toString()
}

const PORT = process.env.PORT
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 400,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  ipv6Subnet: 56
})

const app = express()
app.set('trust proxy', 1) // chạy sau nginx LB: tin X-Forwarded-For để rate-limit nhận đúng IP client
app.use(express.json()) // biến request từ object thành json
app.use(cookieParse()) // middleware để parse cookie từ request header
app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: 'cross-origin'
    }
  })
) // bảo mật cho server

const allowedOrigins = [envConfig.frontend_url]

app.use(
  cors({
    origin: allowedOrigins, // những domain có thể truy cập vào server
    credentials: true
  })
)
app.use(['/users'], limiter)

app.use('/users', userRoutes)
app.use('/friends', friendRoutes)
app.use('/channels', channelRoutes)
app.use('/channel-invites', channelInviteRoutes)
app.use('/workspaces', workspaceRoutes)
app.use('/socket', socketRoutes)
app.use('/search', searchRoutes)
app.use(errorHandler)

databaseServices.connect().then(async () => {
  console.log('Connected to database')
})

const httpServer = createServer(app) // tạo 1 server đựa trên app của Express

const start = async () => {
  try {
    await initialSocket(httpServer)

    httpServer.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`)
    })

    // Worker + aggregator chỉ khởi động sau khi io sẵn sàng
    startUnreadAggregator()
    startUnreadWorker()
    console.log('[BullMQ] worker + aggregator started')

    setInterval(() => {
      cleanupIdlePresence().catch((err) => console.error('[Presence cleanup]', err))
    }, 60_000)
  } catch (err) {
    console.error('[Server] khởi động thất bại:', err)
    process.exit(1)
  }
}

start()

const shutdown = async (signal: string) => {
  console.log(`[Server] nhận ${signal}, đang shutdown...`)
  try {
    await closeRedisAdapter()
  } catch (err) {
    console.error('[Server] shutdown error:', err)
  }
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
