import { Router } from 'express'
import { getChannelMessagesController, getDirectMessageChannelsController } from '~/controllers/channel.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler, validate, validateParams, validateQuery } from '~/middlewares/errorHandler.middlewares'
import { queryBase } from '~/models/schemas/query.schema'
import { channelIdSchema, userIdParamSchema } from '~/models/schemas/user.schemas'
const router = Router()

// lấy tin nhắn của phòng chat dựa trên channelId
router.get(
  '/messages/:channelId',
  accessTokenValidator,
  validateParams(channelIdSchema),
  validateQuery(queryBase),
  asyncHandler(getChannelMessagesController)
)

// lấy thông tin phòng chat channel DM của dựa tren userId (receiver)
router.get(
  '/direct-messages/:userId',
  accessTokenValidator,
  validateParams(userIdParamSchema),
  asyncHandler(getDirectMessageChannelsController)
)

export default router
