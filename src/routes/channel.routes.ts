import { Router } from 'express'
import {
  createChannelController,
  getChannelDetailController,
  getChannelMessagesController,
  getDirectMessageChannelsController,
  updateChannelNicknameController,
  updateChannelSettingsController,
  uploadImageController
} from '~/controllers/channel.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler, validate, validateParams, validateQuery } from '~/middlewares/errorHandler.middlewares'
import { queryBase } from '~/models/schemas/query.schema'
import { channelIdSchema, userIdParamSchema } from '~/models/schemas/user.schemas'
import {
  createChannelSchema,
  updateChannelConfigSchema,
  updateChannelNicknameSchema
} from '../models/schemas/channel.schema'
import { uploadMiddleware } from '~/middlewares/upload.middlewares'
const router = Router()

// tạo channel
router.post('/', accessTokenValidator, validate(createChannelSchema), asyncHandler(createChannelController))

// upload ảnh
router.post('/:id/upload', accessTokenValidator, uploadMiddleware(), asyncHandler(uploadImageController))

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

router.patch(
  '/:channelId/settings',
  accessTokenValidator,
  validateParams(channelIdSchema),
  validate(updateChannelConfigSchema),
  asyncHandler(updateChannelSettingsController)
)

router.patch(
  '/:channelId/nicknames',
  accessTokenValidator,
  validateParams(channelIdSchema),
  validate(updateChannelNicknameSchema),
  asyncHandler(updateChannelNicknameController)
)

export default router
