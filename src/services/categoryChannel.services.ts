import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { CategoryChannelResponse } from '~/models/responses/categoryChannel.response'
import databaseServices from './database.services'

class CategoryChannelService {
  private mapCategoryChannel(category: {
    id: bigint
    workspaceId: bigint
    name: string
    position: number
    createdAt: Date
    updatedAt: Date
  }): CategoryChannelResponse {
    return {
      id: category.id.toString(),
      workspaceId: category.workspaceId.toString(),
      name: category.name,
      position: category.position,
      createdAt: category.createdAt.toISOString(),
      updatedAt: category.updatedAt.toISOString()
    }
  }

  async createCategoryChannel(workspaceId: bigint, name: string) {
    const workspace = await databaseServices.prisma.workspace.findUnique({
      where: {
        id: workspaceId
      }
    })

    if (!workspace) {
      throw new ErrorWithStatus({
        message: 'Workspace không tồn tại',
        status: httpStatus.NOTFOUND
      })
    }

    const existingCategory = await databaseServices.prisma.categoryChannel.findFirst({
      where: {
        workspaceId,
        name
      }
    })

    if (existingCategory) {
      throw new ErrorWithStatus({
        message: 'Category đã tồn tại trong workspace này',
        status: httpStatus.BAD_REQUESTED
      })
    }

    const lastCategory = await databaseServices.prisma.categoryChannel.findFirst({
      where: {
        workspaceId
      },
      orderBy: {
        position: 'desc'
      },
      select: {
        position: true
      }
    })

    const nextPosition = (lastCategory?.position ?? 0) + 1

    const category = await databaseServices.prisma.categoryChannel.create({
      data: {
        workspaceId,
        name,
        position: nextPosition
      }
    })

    return this.mapCategoryChannel(category)
  }

  async getCategoriesByWorkspaceId(workspaceId: bigint) {
    const workspace = await databaseServices.prisma.workspace.findUnique({
      where: {
        id: workspaceId
      }
    })

    if (!workspace) {
      throw new ErrorWithStatus({
        message: 'Workspace không tồn tại',
        status: httpStatus.NOTFOUND
      })
    }

    const categories = await databaseServices.prisma.categoryChannel.findMany({
      where: {
        workspaceId
      },
      orderBy: {
        position: 'asc'
      }
    })

    return categories.map((category) => this.mapCategoryChannel(category))
  }

  async updateCategoryChannel(workspaceId: bigint, categoryId: bigint, data: { name?: string; position?: number }) {
    const category = await databaseServices.prisma.categoryChannel.findFirst({
      where: {
        id: categoryId,
        workspaceId
      }
    })

    if (!category) {
      throw new ErrorWithStatus({
        message: 'Không tìm thấy category',
        status: httpStatus.NOTFOUND
      })
    }

    if (data.name && data.name !== category.name) {
      const duplicateCategory = await databaseServices.prisma.categoryChannel.findFirst({
        where: {
          workspaceId,
          name: data.name,
          NOT: {
            id: categoryId
          }
        }
      })

      if (duplicateCategory) {
        throw new ErrorWithStatus({
          message: 'Category đã tồn tại trong workspace này',
          status: httpStatus.BAD_REQUESTED
        })
      }
    }

    const updatedCategory = await databaseServices.prisma.categoryChannel.update({
      where: {
        id: categoryId
      },
      data: {
        name: data.name,
        position: data.position
      }
    })

    return this.mapCategoryChannel(updatedCategory)
  }

  async deleteCategoryChannel(workspaceId: bigint, categoryId: bigint) {
    const category = await databaseServices.prisma.categoryChannel.findFirst({
      where: {
        id: categoryId,
        workspaceId
      }
    })

    if (!category) {
      throw new ErrorWithStatus({
        message: 'Không tìm thấy category',
        status: httpStatus.NOTFOUND
      })
    }

    await databaseServices.prisma.categoryChannel.delete({
      where: {
        id: categoryId
      }
    })
  }
}

export default new CategoryChannelService()
