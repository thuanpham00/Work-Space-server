import { Router } from 'express'
import {
  createChannelController,
  getChannelAttachmentsController,
  getChannelDetailController,
  getChannelMessagesController,
  getUnreadChannelController,
  updateChannelController,
  updateChannelNicknameController,
  updateChannelSettingsController,
  uploadFileMessageController
} from '~/controllers/channel.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler, validate, validateParams, validateQuery } from '~/middlewares/errorHandler.middlewares'
import { queryBase } from '~/models/schemas/query.schema'
import { channelIdSchema } from '~/models/schemas/user.schemas'
import {
  createChannelSchema,
  updateChannelConfigSchema,
  updateChannelNicknameSchema,
  updateChannelSchema
} from '../models/schemas/channel.schema'
import { uploadMessageMiddleware } from '~/middlewares/upload.middlewares'
const router = Router()

// lấy trạng thái unread của bạn bè đối với userId
router.get('/unread', accessTokenValidator, asyncHandler(getUnreadChannelController))

// tạo channel
router.post('/', accessTokenValidator, validate(createChannelSchema), asyncHandler(createChannelController))

// cập nhật channel (không cho update type)
router.patch(
  '/:channelId',
  accessTokenValidator,
  validateParams(channelIdSchema),
  validate(updateChannelSchema),
  asyncHandler(updateChannelController)
)

// upload ảnh
router.post('/:id/upload', accessTokenValidator, uploadMessageMiddleware(), asyncHandler(uploadFileMessageController))

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

// lấy tin nhắn của phòng chat dựa trên channelId
router.get(
  '/attachments/:channelId',
  accessTokenValidator,
  validateParams(channelIdSchema),
  validateQuery(queryBase),
  asyncHandler(getChannelAttachmentsController)
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
