import { Router } from 'express'
import { getDirectMessageChannelsController } from '~/controllers/channel.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler, validate } from '~/middlewares/errorHandler.middlewares'
const router = Router()

// danh sách channel DM
router.get('/direct-messages', accessTokenValidator, asyncHandler(getDirectMessageChannelsController))

export default router
