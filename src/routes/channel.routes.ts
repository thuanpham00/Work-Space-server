import { Router } from 'express'
import {
  cancelJoinRequestController,
  createChannelController,
  createInviteLinkController,
  getActiveInviteLinkController,
  getChannelAttachmentsController,
  getChannelDetailController,
  getChannelMessagesController,
  getChannelRequestsController,
  getChannelStatusController,
  getFriendsToInviteController,
  getUnreadChannelController,
  requestJoinChannelController,
  revokeInviteLinkController,
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
import { createInviteLinkSchema } from '~/models/schemas/workspace.schema'
import { uploadMessageMiddleware } from '~/middlewares/upload.middlewares'
import {
  channelAdminValidator,
  checkChannelExistAndUserIsMember,
  checkChannelExistOnly
} from '~/middlewares/channel.middlewares'
const router = Router()

// lấy trạng thái unread của bạn bè đối với userId
router.get('/unread', accessTokenValidator, asyncHandler(getUnreadChannelController))

// lấy chi tiết channel dựa trên channelId
router.get(
  '/:channelId',
  accessTokenValidator,
  validateParams(channelIdSchema),
  checkChannelExistAndUserIsMember,
  asyncHandler(getChannelDetailController)
)

// lấy tin nhắn của phòng chat dựa trên channelId
router.get(
  '/:channelId/messages',
  accessTokenValidator,
  validateParams(channelIdSchema),
  validateQuery(queryBase),
  checkChannelExistAndUserIsMember,
  asyncHandler(getChannelMessagesController)
)

// lấy thông tin channel + trạng thái ChannelMember của user hiện tại (chỉ yêu cầu đăng nhập)
router.get(
  '/:channelId/status',
  accessTokenValidator,
  validateParams(channelIdSchema),
  checkChannelExistOnly,
  asyncHandler(getChannelStatusController)
)

// lấy tin nhắn của phòng chat dựa trên channelId
router.get(
  '/:channelId/attachments',
  accessTokenValidator,
  validateParams(channelIdSchema),
  validateQuery(queryBase),
  checkChannelExistAndUserIsMember,
  asyncHandler(getChannelAttachmentsController)
)

// Lấy danh sách lời mời + yêu cầu tham gia channel (chỉ OWNER/ADMIN của workspace)
router.get(
  '/:channelId/requests',
  accessTokenValidator,
  validateParams(channelIdSchema),
  checkChannelExistAndUserIsMember,
  channelAdminValidator(),
  asyncHandler(getChannelRequestsController)
)

// lấy danh sách bạn bè để mời vào channel (đã loại trừ member hiện tại)
router.get(
  '/:channelId/invite-friends',
  accessTokenValidator,
  validateParams(channelIdSchema),
  validateQuery(queryBase),
  checkChannelExistAndUserIsMember,
  channelAdminValidator(),
  asyncHandler(getFriendsToInviteController)
)

// GET link ACTIVE hiện tại (chỉ OWNER/ADMIN của workspace)
router.get(
  '/:channelId/link',
  accessTokenValidator,
  validateParams(channelIdSchema),
  checkChannelExistAndUserIsMember,
  channelAdminValidator(),
  asyncHandler(getActiveInviteLinkController)
)

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

// Tạo link mới (chỉ OWNER/ADMIN)
router.post(
  '/:channelId/link',
  accessTokenValidator,
  validateParams(channelIdSchema),
  validate(createInviteLinkSchema),
  channelAdminValidator(),
  asyncHandler(createInviteLinkController)
)

// Thu hồi link (chỉ OWNER/ADMIN)
router.patch(
  '/:channelId/link/:code/revoke',
  accessTokenValidator,
  validateParams(channelIdSchema),
  channelAdminValidator(),
  asyncHandler(revokeInviteLinkController)
)

// User tự gửi yêu cầu xin vào channel (channel public, không yêu cầu member)
router.post(
  '/:channelId/request-join',
  accessTokenValidator,
  validateParams(channelIdSchema),
  checkChannelExistOnly,
  asyncHandler(requestJoinChannelController)
)

// User hủy yêu cầu xin vào channel đã gửi trước đó
router.delete(
  '/:channelId/request-join',
  accessTokenValidator,
  validateParams(channelIdSchema),
  checkChannelExistOnly,
  asyncHandler(cancelJoinRequestController)
)

export default router
