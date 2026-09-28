import { Request, Response } from 'express'
import { ParamsDictionary } from 'express-serve-static-core'
import { GetAllUsersQueryParams } from '~/models/requests/user.requests'
import { ApiResponse, TokenPayload } from '~/models/responses/user.responses'
import { searchService, SearchType } from '~/services/search.services'

const VALID_TYPES: ReadonlyArray<SearchType> = ['all', 'users', 'workspaces']

type SearchResultItem =
  | {
      id: string
      email: string
      username: string | null
      displayName: string | null
      avatar: string | null
      status: string
      createdAt: Date
      fullName: string | null
      phone: string | null
      bio: string | null
      dateOfBirth: string | null
      gender: string | null
      type: 'user'
      friendStatus: string | null
    }
  | {
      id: string
      name: string
      description: string | null
      avatar: string | null
      ownerId: string | null
      owner: {
        id: string
        username: string | null
        fullName: string | null
        avatar: string | null
      }
      createdAt: Date
      type: 'workspace'
    }

export const getSearchController = async (
  req: Request<ParamsDictionary, any, any, GetAllUsersQueryParams>,
  res: Response
) => {
  const { page, limit, search, type } = req.query
  const { user_id: me_id } = req.decode_authorization as TokenPayload

  const normalizedType: SearchType =
    type && (VALID_TYPES as readonly string[]).includes(type as string) ? (type as SearchType) : 'all'

  const result = await searchService.searchAll(
    page as string,
    limit as string,
    search as string,
    me_id as string,
    normalizedType
  )

  const response: ApiResponse<{
    items: SearchResultItem[]
    total: number
    page: number
    limit: number
    totalPages: number
    type: SearchType
  }> = {
    message: 'Lấy danh sách users và workspaces thành công',
    data: {
      items: result.items as unknown as SearchResultItem[],
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      type: normalizedType
    }
  }

  res.json(response)
}
