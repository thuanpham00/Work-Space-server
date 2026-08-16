import { Request, Response, Router } from 'express'
import { accessTokenValidator } from '~/middlewares/auth.middlewares'
import { asyncHandler } from '~/middlewares/errorHandler.middlewares'

const router = Router()

router.post(
  '/sync-refresh-token',
  accessTokenValidator,
  asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body
    console.log('refreshToken body', refreshToken)

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      // secure: true,
      sameSite: 'lax',
      maxAge: 100 * 24 * 60 * 60 * 1000, // Đồng bộ thời gian sống cookie (100 ngày)
      path: '/'
    })

    res.json({ message: 'Refresh token synced successfully' })
  })
)

export default router
