import { Router } from 'express'
import {
  changePasswordController,
  getAllUsers,
  getMeController,
  getUserById,
  loginController,
  logoutController,
  refreshTokenController,
  registerController,
  updateStatus,
  updateUser,
  uploadImageController
} from '../controllers/user.controller'
import { asyncHandler, validate } from '../middlewares/errorHandler.middlewares'
import { uploadMiddleware } from '~/middlewares/upload.middlewares'
import {
  updateUserSchema,
  updateStatusSchema,
  registerSchema,
  loginSchema,
  changePasswordSchema
} from '../models/schemas/user.schemas'
import { accessTokenValidator, refreshTokenValidator } from '~/middlewares/auth.middlewares'

const router = Router()

router.post('/register', validate(registerSchema), asyncHandler(registerController))

router.post('/login', validate(loginSchema), asyncHandler(loginController))

router.post('/logout', accessTokenValidator, refreshTokenValidator, asyncHandler(logoutController))

router.post('/refresh-token', refreshTokenValidator, asyncHandler(refreshTokenController))

router.get('/', asyncHandler(getAllUsers))

router.get('/me', accessTokenValidator, asyncHandler(getMeController))

router.get('/:userId', asyncHandler(getUserById))

router.patch('/me', accessTokenValidator, validate(updateUserSchema), asyncHandler(updateUser))

router.post('/change-password', accessTokenValidator, validate(changePasswordSchema), asyncHandler(changePasswordController))

router.post('/upload', accessTokenValidator, uploadMiddleware(), asyncHandler(uploadImageController))

router.patch('/:userId/status', accessTokenValidator, validate(updateStatusSchema), asyncHandler(updateStatus))

export default router
