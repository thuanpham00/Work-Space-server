import { Response } from 'express'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { CategoryChannelResponse } from '~/models/responses/categoryChannel.response'
import { ApiResponse } from '~/models/responses/user.responses'
import {
  DeleteCategoryChannelBody,
  CreateCategoryChannelBody,
  UpdateCategoryChannelBody,
  CategoryChannelIdParams,
  WorkspaceIdParams
} from '../models/schemas/categoryChannel.schema'
import categoryChannelServices from '~/services/categoryChannel.services'

export const getCategoriesByWorkspaceController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId } = req.params as WorkspaceIdParams

  const categories = await categoryChannelServices.getCategoriesByWorkspaceId(BigInt(workspaceId))

  const response: ApiResponse<{ categories: CategoryChannelResponse[] }> = {
    message: 'Lấy danh sách category thành công',
    data: {
      categories
    }
  }

  res.json(response)
}

export const createCategoryChannelController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId, name } = req.body as CreateCategoryChannelBody

  const category = await categoryChannelServices.createCategoryChannel(BigInt(workspaceId), name)

  const response: ApiResponse<{ category: CategoryChannelResponse }> = {
    message: 'Tạo category thành công',
    data: {
      category
    }
  }

  res.status(201).json(response)
}

export const updateCategoryChannelController = async (req: AuthenticatedRequest, res: Response) => {
  const { categoryId } = req.params as CategoryChannelIdParams
  const { workspaceId, ...data } = req.body as UpdateCategoryChannelBody

  const category = await categoryChannelServices.updateCategoryChannel(BigInt(workspaceId), BigInt(categoryId), data)

  const response: ApiResponse<{ category: CategoryChannelResponse }> = {
    message: 'Cập nhật category thành công',
    data: {
      category
    }
  }

  res.json(response)
}

export const deleteCategoryChannelController = async (req: AuthenticatedRequest, res: Response) => {
  const { categoryId } = req.params as CategoryChannelIdParams
  const { workspaceId } = req.body as DeleteCategoryChannelBody

  await categoryChannelServices.deleteCategoryChannel(BigInt(workspaceId), BigInt(categoryId))

  const response: ApiResponse<null> = {
    message: 'Xóa category thành công'
  }

  res.json(response)
}
