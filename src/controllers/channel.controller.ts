/* eslint-disable @typescript-eslint/no-explicit-any */
import { Response } from 'express'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { ChannelDM } from '~/models/responses/channel.response'
import { Message } from '~/models/responses/message.response'
import { ApiResponse, TokenPayload } from '~/models/responses/user.responses'
import { QueryBase } from '~/models/schemas/query.schema'
import channelServices from '~/services/channel.services'

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
