import { Request } from 'express'
import { TokenPayload } from '~/models/responses/user.responses'

export interface GetUserParams {
  userId: string
}

export interface SearchUserQueryParams extends Request {
  query: {
    q: string
  }
}

export interface UpdateUserParams {
  userId: string
}

export interface UpdateStatusParams {
  userId: string
}

export interface AuthenticatedRequest extends Request {
  user: TokenPayload
}
