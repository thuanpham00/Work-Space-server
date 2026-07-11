import { Request, Response, NextFunction } from 'express'
import { ErrorWithStatus } from '../constants/errors'

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof ErrorWithStatus) {
    res.status(err.status).json({
      message: err.message
    })
    return
  }

  // Kiểm tra nếu là lỗi Zod
  if (err.name === 'ZodError') {
    const firstMessage = err.issues?.[0]?.message ?? 'Validation failed'
    res.status(400).json({
      message: firstMessage,
      errors: err.issues
    })
    return
  }

  // Các lỗi khác
  console.error('Error:', err)

  res.status(500).json({
    message: 'Internal Server Error'
  })
}

// Middleware validate request body với Zod
export const validate = (schema: any) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.body)
      next()
    } catch (error: any) {
      const firstMessage = error.issues?.[0]?.message ?? 'Validation failed'
      res.status(400).json({
        message: firstMessage,
        errors: error.issues
      })
    }
  }
}

// Middleware validate query params với Zod
export const validateQuery = (schema: any) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.query)
      next()
    } catch (error: any) {
      const firstMessage = error.issues?.[0]?.message ?? 'Validation failed'
      res.status(400).json({
        message: firstMessage,
        errors: error.issues
      })
    }
  }
}

// Middleware validate params với Zod
export const validateParams = (schema: any) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.params)
      next()
    } catch (error: any) {
      const firstMessage = error.issues?.[0]?.message ?? 'Validation failed'
      res.status(400).json({
        message: firstMessage,
        errors: error.issues
      })
    }
  }
}

// Middleware xử lý async (tránh try-catch trong controller) - để khỏi trycatch trong từng controller
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(next)
    } catch (error) {
      next(error)
    }
  }
}
