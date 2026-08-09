import { Router } from 'express'
import {
  createChannelController,
  getChannelDetailController,
  getChannelMessagesController,
  getDirectMessageChannelsController
} from '~/controllers/channel.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler, validate, validateParams, validateQuery } from '~/middlewares/errorHandler.middlewares'
import { queryBase } from '~/models/schemas/query.schema'
import { channelIdSchema, userIdParamSchema } from '~/models/schemas/user.schemas'
import { createChannelSchema } from '../models/schemas/channel.schema'
const router = Router()

router.post('/', accessTokenValidator, validate(createChannelSchema), asyncHandler(createChannelController))

// lấy chi tiết channel dựa trên channelId
router.get(
  '/:channelId',
  accessTokenValidator,
  validateParams(channelIdSchema),
  asyncHandler(getChannelDetailController)
)

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
