import { Router } from 'express'
import {
  cancelJoinRequestController,
  getWorkspaceDetailController,
  getWorkspaceMemberStatusController,
  getWorkspaceMembersController,
  getWorkspaceRequestsController,
  getWorkspaceUserController,
  requestInviteToWorkspaceController
} from '~/controllers/workspace.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler, validateQuery } from '~/middlewares/errorHandler.middlewares'
import { getWorkspaceMembersSchema } from '~/models/schemas/workspace.schema'
import categoryChannelRoutes from '~/routes/categoryChannel.routes'

const router = Router()

// lấy thông tin workspace của user hiện tại (workspace của user và workspace mà user là thành viên)
router.get('/', accessTokenValidator, asyncHandler(getWorkspaceUserController))

// lấy thông tin workspace của user hiện tại gồm ds channel của workspace
router.get('/:id', accessTokenValidator, asyncHandler(getWorkspaceDetailController))

router.get('/:id/member', accessTokenValidator, asyncHandler(getWorkspaceDetailController))

// check trạng thái user đó đối với workspace hiện tại (tham gia, gửi lời mời, hay nhận lời mời, đã từ chối)
router.get('/:workspaceId/status', accessTokenValidator, asyncHandler(getWorkspaceMemberStatusController))

// lấy danh sách thành viên ACTIVE của workspace
router.get(
  '/:workspaceId/members',
  accessTokenValidator,
  validateQuery(getWorkspaceMembersSchema),
  asyncHandler(getWorkspaceMembersController)
)

// lấy danh sách lời mời / yêu cầu tham gia workspace (chỉ OWNER/ADMIN)
router.get('/:workspaceId/requests', accessTokenValidator, asyncHandler(getWorkspaceRequestsController))

router.post('/:workspaceId/request-invite', accessTokenValidator, asyncHandler(requestInviteToWorkspaceController))

// rút yêu cầu tham gia workspace
router.delete('/:workspaceId/request-invite', accessTokenValidator, asyncHandler(cancelJoinRequestController))

// CRUD category của workspace
router.use('/categories', categoryChannelRoutes)

export default router
