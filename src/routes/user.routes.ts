import { Router } from 'express'
import {
  addFriendController,
  changePasswordController,
  getAllFriendsController,
  getAllUsers,
  getMeController,
  getUserStatusController,
  getWorkspaceUserController,
  loginController,
  logoutController,
  refreshTokenController,
  registerController,
  updateStatus,
  updateUser,
  uploadImageController
} from '../controllers/user.controller'
import { asyncHandler, validate, validateQuery } from '../middlewares/errorHandler.middlewares'
import { uploadMiddleware } from '~/middlewares/upload.middlewares'
import {
  updateUserSchema,
  updateStatusSchema,
  registerSchema,
  loginSchema,
  changePasswordSchema,
  addFriendSchema
} from '../models/schemas/user.schemas'
import { accessTokenValidator, refreshTokenValidator } from '~/middlewares/auth.middlewares'
import { friendSchema } from '~/models/schemas/friend.schema'

const router = Router()

// đăng ký
router.post('/register', validate(registerSchema), asyncHandler(registerController))

// đăng nhập
router.post('/login', validate(loginSchema), asyncHandler(loginController))

// đăng xuất
router.post('/logout', accessTokenValidator, refreshTokenValidator, asyncHandler(logoutController))

// làm mới token
router.post('/refresh-token', refreshTokenValidator, asyncHandler(refreshTokenController))

// lấy ds tất cả user dựa trên search
router.get('/', accessTokenValidator, asyncHandler(getAllUsers))

// lấy thông tin user hiện tại
router.get('/me', accessTokenValidator, asyncHandler(getMeController))

// lấy thông tin workspace của user hiện tại (workspace của user và workspace mà user là thành viên)
router.get('/workspaces', accessTokenValidator, asyncHandler(getWorkspaceUserController))

// lấy thông tin user theo id
// router.get('/:userId', asyncHandler(getUserById))

// lấy thông tin user và trạng thái friend của user đó với user hiện tại
router.get('/:userId/status', accessTokenValidator, asyncHandler(getUserStatusController))

// cập nhật thông tin user hiện tại
router.patch('/me', accessTokenValidator, validate(updateUserSchema), asyncHandler(updateUser))

// thay đổi mật khẩu
router.post(
  '/change-password',
  accessTokenValidator,
  validate(changePasswordSchema),
  asyncHandler(changePasswordController)
)

// upload ảnh
router.post('/upload', accessTokenValidator, uploadMiddleware(), asyncHandler(uploadImageController))

// cập nhật trạng thái user
router.patch('/:userId/status', accessTokenValidator, validate(updateStatusSchema), asyncHandler(updateStatus))

// thêm bạn bè
router.post('/addFriend', accessTokenValidator, validate(addFriendSchema), asyncHandler(addFriendController))

// lấy danh sách bạn bè dựa trên trạng thái (pending, accepted, tất cả)
router.get('/friends', accessTokenValidator, validateQuery(friendSchema), asyncHandler(getAllFriendsController))
export default router
