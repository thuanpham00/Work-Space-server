import { Router } from 'express'
import {
  listNotificationsController,
  markAllNotificationsAsReadController,
  markNotificationAsReadController
} from '~/controllers/notification.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler, validateParams, validateQuery } from '~/middlewares/errorHandler.middlewares'
import { notificationIdParamSchema, notificationQuerySchema } from '~/models/schemas/notification.schema'

const router = Router()

// Danh sách thông báo (phân trang + filter)
router.get('/', accessTokenValidator, validateQuery(notificationQuerySchema), asyncHandler(listNotificationsController))

// Đánh dấu toàn bộ đã đọc
router.patch('/read-all', accessTokenValidator, asyncHandler(markAllNotificationsAsReadController))

// Đánh dấu 1 cái đã đọc
router.patch(
  '/:id/read',
  accessTokenValidator,
  validateParams(notificationIdParamSchema),
  asyncHandler(markNotificationAsReadController)
)

export default router
