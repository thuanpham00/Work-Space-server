import { Router } from 'express'
import { getWorkspaceByInviteCodeController } from '~/controllers/workspaceInvite.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler, validateParams } from '~/middlewares/errorHandler.middlewares'
import { workspaceInviteCodeParamSchema } from '~/models/schemas/workspaceInvite.shema'

const router = Router()

router.get(
  '/:code',
  accessTokenValidator,
  validateParams(workspaceInviteCodeParamSchema),
  asyncHandler(getWorkspaceByInviteCodeController)
)

export default router
