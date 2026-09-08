import { Router } from 'express'
import {
  acceptFriendController,
  addFriendController,
  getAllFriendsChannelsController,
  getAllFriendsController,
  rejectFriendController
} from '~/controllers/friend.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler, validate, validateQuery } from '~/middlewares/errorHandler.middlewares'
import { friendSchema } from '~/models/schemas/friend.schema'
import { addFriendSchema } from '~/models/schemas/user.schemas'
const router = Router()

// lấy danh sách bạn bè dựa trên trạng thái (pending, accepted, tất cả)
router.get('/', accessTokenValidator, validateQuery(friendSchema), asyncHandler(getAllFriendsController))

// lấy danh sách channel của bạn bè đã accept
router.get('/channels', accessTokenValidator, asyncHandler(getAllFriendsChannelsController))

// thêm bạn bè
router.post('/add', accessTokenValidator, validate(addFriendSchema), asyncHandler(addFriendController))

// đồng ý kết bạn
router.post('/accept', accessTokenValidator, validate(addFriendSchema), asyncHandler(acceptFriendController))

// từ chối kết bạn
router.post('/reject', accessTokenValidator, validate(addFriendSchema), asyncHandler(rejectFriendController))

export default router
