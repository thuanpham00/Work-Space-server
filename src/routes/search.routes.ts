import { Router } from 'express'
import { getSearchController } from '~/controllers/search.controller'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler } from '~/middlewares/errorHandler.middlewares'

const router = Router()

// lấy ds tất cả user dựa trên search
router.get('/', accessTokenValidator, asyncHandler(getSearchController))

export default router
