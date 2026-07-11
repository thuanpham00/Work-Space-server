import { Request, Response, NextFunction } from 'express'
import formidable, { File as FormidableFile, Options as FormidableOptions } from 'formidable'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'

export interface UploadedFile extends FormidableFile {
  filepath: string
  originalFilename: string | null
  mimetype: string | null
  size: number
}

/**
 * Middleware wrap formidable để parse multipart/form-data.
 * Sau khi parse xong, file sẽ nằm ở `req.uploadedFiles` (mảng các FormidableFile).
 * Middleware này cố tình wrap bằng Promise để xử lý async cho gọn.
 */
export const uploadMiddleware = (options?: FormidableOptions) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const form = formidable({
      maxFileSize: 5 * 1024 * 1024,
      filter: ({ mimetype }) => Boolean(mimetype && mimetype.startsWith('image/')),
      ...options
    })

    try {
      const [, files] = (await form.parse(req)) as [unknown, Record<string, FormidableFile[] | undefined>]
      const flatFiles: UploadedFile[] = []
      for (const fieldName of Object.keys(files)) {
        const arr = files[fieldName]
        if (!arr) continue
        for (const file of arr) {
          flatFiles.push({
            ...file,
            mimetype: file.mimetype ?? null,
            originalFilename: file.originalFilename ?? null
          })
        }
      }
      ;(req as Request & { uploadedFiles?: UploadedFile[] }).uploadedFiles = flatFiles
      next()
    } catch (error) {
      next(
        new ErrorWithStatus({
          message: error instanceof Error ? error.message : 'Upload file thất bại',
          status: httpStatus.BAD_REQUESTED
        })
      )
    }
  }
}

/**
 * Lấy file đầu tiên theo tên field. Throw nếu không có.
 */
export const getUploadedFile = (req: Request, fieldName: string): UploadedFile => {
  const files = (req as Request & { uploadedFiles?: UploadedFile[] }).uploadedFiles ?? []
  const matched = files.find((f) => f.originalFilename !== null || f.size > 0)
  const file = matched ?? files[0]

  if (!file) {
    throw new ErrorWithStatus({
      message: `Không tìm thấy file upload (field "${fieldName}")`,
      status: httpStatus.BAD_REQUESTED
    })
  }
  return file
}
