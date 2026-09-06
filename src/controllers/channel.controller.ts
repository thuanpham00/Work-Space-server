/* eslint-disable @typescript-eslint/no-explicit-any */
import { Response } from 'express'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { getUploadedFile } from '~/middlewares/upload.middlewares'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { Channel, ChannelDM } from '~/models/responses/channel.response'
import { Message } from '~/models/responses/message.response'
import { ApiResponse, TokenPayload } from '~/models/responses/user.responses'
import { CreateChannelBody } from '~/models/schemas/channel.schema'
import { QueryBase } from '~/models/schemas/query.schema'
import channelServices from '~/services/channel.services'
import fs from 'fs'
import r2Services from '~/services/r2.services'
import { UpdateChannelConfigBody, UpdateChannelNicknameBody } from '~/models/requests/channel.request'
import { Socket_Room } from '~/socket/utils'
import { io } from '~/socket/socket'

export const createChannelController = async (req: AuthenticatedRequest, res: Response) => {
  const channel = await channelServices.createChannel(req.body as CreateChannelBody)

  const response: ApiResponse<{ channel: Channel }> = {
    message: 'Tạo channel thành công',
    data: {
      channel
    }
  }

  res.status(201).json(response)
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

export const getChannelAttachmentsController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params as { channelId: string }
  const { page, limit } = req.query as QueryBase

  const { attachments, total } = await channelServices.getAttachmentsForChannel(
    BigInt(channelId),
    Number(limit),
    Number(page)
  )

  const response: ApiResponse<{ attachments: any[]; total_page: number; limit: number; page: number }> = {
    message: 'Lấy danh sách attachments thành công',
    data: {
      attachments: attachments as any,
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

export const uploadFileMessageController = async (req: AuthenticatedRequest, res: Response) => {
  const uploadedFile = getUploadedFile(req, 'file')
  const buffer = fs.readFileSync(uploadedFile.filepath)
  const channelId = req.params.id
  const link = `channel/${channelId}`

  const result = await r2Services.uploadFileMessage(buffer, link, {
    originalFilename: uploadedFile.originalFilename,
    mimetype: uploadedFile.mimetype
  })

  const response: ApiResponse<typeof result> = {
    message: 'Upload file thành công',
    data: result
  }

  res.status(httpStatus.CREATED).json(response)
}

export const updateChannelSettingsController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params as { channelId: string }
  const { user_id: userId } = req.decode_authorization as TokenPayload
  const { backgroundColor, backgroundUrl, accent } = req.body as UpdateChannelConfigBody

  const payload = {
    backgroundColor: backgroundColor,
    backgroundUrl: backgroundUrl,
    accent: accent
  }

  const { channelConfig, configMessage } = await channelServices.updateChannelConfig(
    BigInt(channelId),
    payload,
    BigInt(userId)
  )

  io?.to(Socket_Room.channel(channelId.toString())).emit('channel_settings_updated', {
    channelId
  })
  io?.to(Socket_Room.channel(channelId.toString())).emit('receive_message', configMessage)

  res.json({
    message: 'Cập nhật cấu hình channel thành công',
    data: {
      channelConfig
    }
  })
}

export const updateChannelNicknameController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params as { channelId: string }
  const { user_id: userId } = req.decode_authorization as TokenPayload
  const { nickname } = req.body as UpdateChannelNicknameBody

  const { channelNickname, configMessage } = await channelServices.updateChannelNickname(
    BigInt(channelId),
    nickname,
    BigInt(userId)
  )

  io?.to(Socket_Room.channel(channelId.toString())).emit('channel_nicknames_updated', {
    channelId
  })
  io?.to(Socket_Room.channel(channelId.toString())).emit('receive_message', configMessage)

  res.json({
    message: 'Cập nhật nickname channel thành công',
    data: {
      channelNickname
    }
  })
}
