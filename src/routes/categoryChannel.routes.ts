import { Router } from 'express'
import {
  createCategoryChannelController,
  deleteCategoryChannelController,
  getCategoriesByWorkspaceController,
  updateCategoryChannelController
} from '~/controllers/categoryChannel.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler, validate, validateParams } from '~/middlewares/errorHandler.middlewares'
import {
  createCategoryChannelSchema,
  deleteCategoryChannelSchema,
  categoryChannelIdSchema,
  workspaceIdSchema,
  updateCategoryChannelSchema as updateCategoryChannelSchemaAlias
} from '../models/schemas/categoryChannel.schema'
const router = Router()

// lấy danh sách category của workspace, không gồm channel
router.get(
  '/:workspaceId',
  accessTokenValidator,
  validateParams(workspaceIdSchema),
  asyncHandler(getCategoriesByWorkspaceController)
)

// tạo category mới trong workspace
router.post(
  '/',
  accessTokenValidator,
  validate(createCategoryChannelSchema),
  asyncHandler(createCategoryChannelController)
)

// cập nhật category trong workspace
router.put(
  '/:categoryId',
  accessTokenValidator,
  validateParams(categoryChannelIdSchema),
  validate(updateCategoryChannelSchemaAlias),
  asyncHandler(updateCategoryChannelController)
)

// xóa category trong workspace
router.delete(
  '/:categoryId',
  accessTokenValidator,
  validateParams(categoryChannelIdSchema),
  validate(deleteCategoryChannelSchema),
  asyncHandler(deleteCategoryChannelController)
)

export default router
