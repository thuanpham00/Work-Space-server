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

import { errorHandler } from '~/middlewares/errorHandler.middlewares'
import { initialSocket } from '~/socket'
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
app.use(express.json()) // biến request từ object thành json
app.use(cookieParse()) // middleware để parse cookie từ request header
app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: 'cross-origin'
    }
  })
) // bảo mật cho server

const allowedOrigins = ['http://localhost:5173', 'http://192.168.100.16:5173']

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

app.use(errorHandler)

databaseServices.connect().then(async () => {
  console.log('Connected to database')
  await databaseServices.initAdminUser()
})

const httpServer = createServer(app) // tạo 1 server đựa trên app của Express

initialSocket(httpServer)

httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`)
})
