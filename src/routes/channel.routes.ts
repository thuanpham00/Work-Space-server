import { Router } from 'express'
import { getChannelMessagesController, getDirectMessageChannelsController } from '~/controllers/channel.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler, validate, validateParams } from '~/middlewares/errorHandler.middlewares'
import { userIdParamSchema } from '~/models/schemas/user.schemas'
const router = Router()

// lấy phòng chat channel DM của dựa tren user gửi vào và token request
router.get(
  '/direct-messages/:userId',
  accessTokenValidator,
  validateParams(userIdParamSchema),
  asyncHandler(getDirectMessageChannelsController)
)

router.get(
  '/direct-messages/:userId/messages',
  accessTokenValidator,
  validateParams(userIdParamSchema),
  asyncHandler(getChannelMessagesController)
)

export default router
