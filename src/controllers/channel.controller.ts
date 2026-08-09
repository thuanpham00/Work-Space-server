/* eslint-disable @typescript-eslint/no-explicit-any */
import { Response } from 'express'
import { ChannelType } from '~/constants/enum'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { Channel, ChannelDM } from '~/models/responses/channel.response'
import { Message } from '~/models/responses/message.response'
import { ApiResponse, TokenPayload } from '~/models/responses/user.responses'
import { CreateChannelBody } from '~/models/schemas/channel.schema'
import { QueryBase } from '~/models/schemas/query.schema'
import channelServices from '~/services/channel.services'
import databaseServices from '~/services/database.services'

export const createChannelController = async (req: AuthenticatedRequest, res: Response) => {
  const { categoryId, name, description, type, isPrivate } = req.body as CreateChannelBody

  const category = await databaseServices.prisma.categoryChannel.findUnique({
    where: {
      id: BigInt(categoryId)
    }
  })

  if (!category) {
    throw new ErrorWithStatus({
      message: 'Category không tồn tại',
      status: httpStatus.NOTFOUND
    })
  }

  const channel = await databaseServices.prisma.channel.create({
    data: {
      workspaceId: category.workspaceId,
      categoryId: category.id,
      name,
      description: description ?? null,
      type: type.toUpperCase() as ChannelType,
      isPrivate: isPrivate ?? false
    }
  })

  const response: ApiResponse<{ channel: Channel }> = {
    message: 'Tạo channel thành công',
    data: {
      channel: {
        id: channel.id.toString(),
        workspaceId: channel.workspaceId ? channel.workspaceId.toString() : null,
        categoryId: channel.categoryId ? channel.categoryId.toString() : null,
        name: channel.name,
        description: channel.description,
        type: channel.type,
        isPrivate: channel.isPrivate,
        createdAt: channel.createdAt.toISOString(),
        updatedAt: channel.updatedAt.toISOString()
      }
    }
  }

  res.status(201).json(response)
}

export const getDirectMessageChannelsController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id: userId } = req.decode_authorization as TokenPayload
  const { userId: receivedId } = req.params as { userId: string }

  const channels = await channelServices.getDirectMessageChannelDetail(BigInt(userId), BigInt(receivedId))
  const response: ApiResponse<{ channel: ChannelDM | null }> = {
    message: 'Lấy chi tiết channels thành công',
    data: {
      channel: channels as unknown as ChannelDM
    }
  }

  res.json(response)
}

export const getChannelMessagesController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params as { channelId: string }
  const { page, limit } = req.query as QueryBase

  const { messages, total } = await channelServices.getMessagesForDM(BigInt(channelId), Number(limit), Number(page))

  const response: ApiResponse<{ messages: Message[]; total_page: number; limit: number; page: number }> = {
    message: 'Lấy danh sách tin nhắn thành công',
    data: {
      messages: messages as any,
      total_page: Math.ceil(total / Number(limit)),
      limit: Number(limit),
      page: Number(page)
    }
  }

  res.json(response)
}

export const getChannelDetailController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params as { channelId: string }

  const channel = await channelServices.getChannelDetail(BigInt(channelId))

  if (!channel) {
    throw new ErrorWithStatus({
      message: 'Channel không tồn tại',
      status: httpStatus.NOTFOUND
    })
  }

  res.json({
    message: 'Lấy chi tiết channel thành công',
    data: {
      channel
    }
  })
}

