import { Router } from 'express'
import {
  cancelInviteController,
  cancelJoinRequestController,
  createInviteLinkController,
  getActiveInviteLinkController,
  getWorkspaceDetailController,
  getWorkspaceMemberStatusController,
  getWorkspaceMembersController,
  getWorkspaceRequestsController,
  getWorkspaceUserController,
  inviteUserToWorkspaceController,
  requestInviteToWorkspaceController,
  revokeInviteLinkController,
  searchUsersToInviteController
} from '~/controllers/workspace.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler, validate, validateParams, validateQuery } from '~/middlewares/errorHandler.middlewares'
import { checkActiveMembershipValidator, workspaceAdminValidator } from '~/middlewares/workspace.middlewares'
import {
  createInviteLinkSchema,
  getWorkspaceMembersSchema,
  inviteSearchSchema,
  inviteUserBodySchema,
  workspaceIdParamSchema
} from '~/models/schemas/workspace.schema'
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
router.get(
  '/:workspaceId/requests',
  accessTokenValidator,
  workspaceAdminValidator(),
  asyncHandler(getWorkspaceRequestsController)
)

// GET link ACTIVE hiện tại (ACTIVE member)
router.get(
  '/:workspaceId/link',
  accessTokenValidator,
  checkActiveMembershipValidator,
  asyncHandler(getActiveInviteLinkController)
)

// search users để mời vào workspace (chỉ ACTIVE member của workspace)
router.get(
  '/:workspaceId/invite-search',
  accessTokenValidator,
  validateQuery(inviteSearchSchema),
  validateParams(workspaceIdParamSchema),
  asyncHandler(searchUsersToInviteController)
)

router.post('/:workspaceId/request-invite', accessTokenValidator, asyncHandler(requestInviteToWorkspaceController))

// rút yêu cầu tham gia workspace
router.delete('/:workspaceId/request-invite', accessTokenValidator, asyncHandler(cancelJoinRequestController))

// mời user vào workspace (chỉ OWNER/ADMIN)
router.post(
  '/:workspaceId/invite',
  accessTokenValidator,
  validateParams(workspaceIdParamSchema),
  workspaceAdminValidator(),
  validate(inviteUserBodySchema),
  asyncHandler(inviteUserToWorkspaceController)
)

// hủy lời mời đã gửi (chỉ OWNER/ADMIN)
router.delete(
  '/:workspaceId/invite',
  accessTokenValidator,
  validateParams(workspaceIdParamSchema),
  workspaceAdminValidator(),
  validate(inviteUserBodySchema),
  asyncHandler(cancelInviteController)
)

// CRUD category của workspace
router.use('/categories', categoryChannelRoutes)

// Tạo link mới (OWNER/ADMIN) — body được validate bằng createInviteLinkSchema
router.post(
  '/:workspaceId/invite-link',
  accessTokenValidator,
  workspaceAdminValidator(),
  validate(createInviteLinkSchema),
  asyncHandler(createInviteLinkController)
)

// Thu hồi link (OWNER/ADMIN)
router.patch(
  '/:workspaceId/invite-link/:code/revoke',
  accessTokenValidator,
  workspaceAdminValidator(),
  asyncHandler(revokeInviteLinkController)
)

export default router
