import { Router } from 'express'
import { getChannelByInviteCodeController } from '~/controllers/channelInvite.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler, validateParams } from '~/middlewares/errorHandler.middlewares'
import { channelInviteCodeParamSchema } from '~/models/schemas/channelInvite.shema'

const router = Router()

router.get(
  '/:code',
  accessTokenValidator,
  validateParams(channelInviteCodeParamSchema),
  asyncHandler(getChannelByInviteCodeController)
)

export default router
