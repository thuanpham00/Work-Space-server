import { Router } from 'express'
import {
  getWorkspaceDetailController,
  getWorkspaceMemberStatusController,
  getWorkspaceUserController
} from '~/controllers/workspace.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler } from '~/middlewares/errorHandler.middlewares'
import categoryChannelRoutes from '~/routes/categoryChannel.routes'

const router = Router()

// lấy thông tin workspace của user hiện tại (workspace của user và workspace mà user là thành viên)
router.get('/', accessTokenValidator, asyncHandler(getWorkspaceUserController))

// lấy thông tin workspace của user hiện tại gồm ds channel của workspace
router.get('/:id', accessTokenValidator, asyncHandler(getWorkspaceDetailController))

// check trạng thái user đó đối với workspace hiện tại
router.get('/:id/status', accessTokenValidator, asyncHandler(getWorkspaceMemberStatusController))

// CRUD category của workspace
router.use('/categories', categoryChannelRoutes)

export default router
