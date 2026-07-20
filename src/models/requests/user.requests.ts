import { Request } from 'express'
import { TokenPayload } from '~/models/responses/user.responses'

export interface AuthenticatedRequest extends Request {
  user: TokenPayload
}

export interface GetAllUsersQueryParams {
  page?: string
  limit?: string
  search?: string
}
