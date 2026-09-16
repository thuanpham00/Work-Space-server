import { Router } from 'express'
import {
  cancelJoinRequestController,
  getWorkspaceDetailController,
  getWorkspaceMemberStatusController,
  getWorkspaceUserController,
  requestInviteToWorkspaceController
} from '~/controllers/workspace.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler } from '~/middlewares/errorHandler.middlewares'
import categoryChannelRoutes from '~/routes/categoryChannel.routes'

const router = Router()

// lấy thông tin workspace của user hiện tại (workspace của user và workspace mà user là thành viên)
router.get('/', accessTokenValidator, asyncHandler(getWorkspaceUserController))

// lấy thông tin workspace của user hiện tại gồm ds channel của workspace
router.get('/:id', accessTokenValidator, asyncHandler(getWorkspaceDetailController))

// check trạng thái user đó đối với workspace hiện tại (tham gia, gửi lời mời, hay nhận lời mời, đã từ chối)
router.get('/:workspaceId/status', accessTokenValidator, asyncHandler(getWorkspaceMemberStatusController))

router.post('/:workspaceId/request-invite', accessTokenValidator, asyncHandler(requestInviteToWorkspaceController))

// rút yêu cầu tham gia workspace
router.delete('/:workspaceId/request-invite', accessTokenValidator, asyncHandler(cancelJoinRequestController))

// CRUD category của workspace
router.use('/categories', categoryChannelRoutes)

export default router
