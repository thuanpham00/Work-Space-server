/* eslint-disable @typescript-eslint/no-explicit-any */
import { Response } from 'express'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { getUploadedFile } from '~/middlewares/upload.middlewares'
import { AuthenticatedRequest } from '~/models/requests/user.requests'
import { Channel, ChannelRequestItem } from '~/models/responses/channel.response'
import { Message } from '~/models/responses/message.response'
import { ApiResponse, TokenPayload } from '~/models/responses/user.responses'
import { CreateChannelBody, UpdateChannelBody } from '~/models/schemas/channel.schema'
import { QueryAttachment, QueryBase } from '~/models/schemas/query.schema'
import channelServices from '~/services/channel.services'
import fs from 'fs'
import r2Services from '~/services/r2.services'
import { UpdateChannelConfigBody, UpdateChannelNicknameBody } from '~/models/requests/channel.request'
import { Socket_Room } from '~/socket/utils'
import { io } from '~/socket/socket'
import { Attachment } from '~/models/responses/attachment.response'
import { InviteLinkData } from '~/models/responses/workspace.response'
import { FriendToInviteChannel } from '~/models/responses/friend.responses'

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

export const updateChannelController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params as { channelId: string }
  const channel = await channelServices.updateChannel(BigInt(channelId), req.body as UpdateChannelBody)

  // Emit socket event để các client khác cập nhật
  io?.to(Socket_Room.channel(channelId.toString())).emit('channel_updated', {
    channelId
  })

  const response: ApiResponse<{ channel: Channel }> = {
    message: 'Cập nhật channel thành công',
    data: {
      channel
    }
  }

  res.json(response)
}

export const createInviteLinkController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params
  const { user_id } = req.decode_authorization as TokenPayload
  const { ttlSeconds } = req.body as { ttlSeconds?: number | null }

  if (!channelId || !user_id) {
    throw new ErrorWithStatus({
      message: 'Thiếu thông tin channelId hoặc userId',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const invite = await channelServices.createInviteLink(BigInt(channelId as string), BigInt(user_id), ttlSeconds)

  const response: ApiResponse<{
    code: string
    url: string
    expiresAt: string | null
    createdAt: string
  }> = {
    message: 'Tạo link mời thành công',
    data: {
      code: invite.code,
      url: `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/invite/${invite.code}`,
      expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
      createdAt: invite.createdAt.toISOString()
    }
  }

  res.json(response)
}

export const revokeInviteLinkController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId, code } = req.params
  const { user_id } = req.decode_authorization as TokenPayload

  if (!channelId || !code || !user_id) {
    throw new ErrorWithStatus({
      message: 'Thiếu thông tin channelId, code hoặc userId',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const codeRaw = Array.isArray(code) ? code[0] : code
  if (!codeRaw) {
    throw new ErrorWithStatus({
      message: 'Thiếu code',
      status: httpStatus.BAD_REQUESTED
    })
  }

  const invite = await channelServices.revokeInviteLink(BigInt(channelId as string), codeRaw, BigInt(user_id))

  const response: ApiResponse<{ code: string; status: string; revokedAt: string | null }> = {
    message: 'Thu hồi link thành công',
    data: {
      code: invite.code,
      status: invite.status,
      revokedAt: invite.revokedAt ? invite.revokedAt.toISOString() : null
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

export const getChannelAttachmentsController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params as { channelId: string }
  const { page, limit, type } = req.query as QueryAttachment

  const { resAttachments, total } = await channelServices.getAttachmentsForChannel(
    BigInt(channelId),
    Number(limit),
    Number(page),
    type
  )

  const response: ApiResponse<{ attachments: Attachment[]; total_page: number; limit: number; page: number }> = {
    message: 'Lấy danh sách attachments thành công',
    data: {
      attachments: resAttachments as any,
      total_page: Math.ceil(total / Number(limit)),
      limit: Number(limit),
      page: Number(page)
    }
  }

  res.json(response)
}

export const getChannelStatusController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params as { channelId: string }
  const { user_id: userId } = req.decode_authorization as TokenPayload

  const { channel } = await channelServices.getChannelStatus(BigInt(channelId), BigInt(userId))

  res.json({
    message: 'Lấy trạng thái channel thành công',
    data: {
      channel
    }
  })
}

export const getChannelDetailController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params as { channelId: string }

  const channel = await channelServices.getChannelDetail(BigInt(channelId))

  res.json({
    message: 'Lấy chi tiết channel thành công',
    data: {
      channel
    }
  })
}

export const getUnreadChannelController = async (req: AuthenticatedRequest, res: Response) => {
  const { user_id } = req.decode_authorization as TokenPayload
  const unreadFriends = await channelServices.getUnreadChannel(BigInt(user_id))

  res.json({
    message: 'Lấy trạng thái unread của channel thành công',
    data: {
      unreadFriends
    }
  })
}

export const getActiveInviteLinkController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params

  const data = await channelServices.getActiveInviteLink(BigInt(channelId as string))

  const response: ApiResponse<InviteLinkData> = {
    message: data ? 'OK' : 'Channel chưa có link mời đang hoạt động',
    data: data
  }

  res.json(response)
}

export const getChannelRequestsController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params
  const { user_id } = req.decode_authorization as TokenPayload

  const requests = await channelServices.getChannelRequests(BigInt(channelId as string), user_id)

  const inviteCount = requests.filter((r) => r.type === 'invite').length
  const joinCount = requests.filter((r) => r.type === 'join').length

  const response: ApiResponse<{ requests: ChannelRequestItem[]; inviteCount: number; joinCount: number }> = {
    message: 'Lấy danh sách lời mời và yêu cầu tham gia channel thành công',
    data: { requests: requests as unknown as ChannelRequestItem[], inviteCount, joinCount }
  }

  res.json(response)
}

export const getFriendsToInviteController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params as { channelId: string }
  const { user_id } = req.decode_authorization as TokenPayload
  const { page, limit, search } = req.query as QueryBase & { search?: string }

  const data = await channelServices.getFriendsToInviteChannel(
    BigInt(user_id),
    BigInt(channelId),
    search ?? '',
    Number(page),
    Number(limit)
  )

  const response: ApiResponse<{
    friends: FriendToInviteChannel[]
    total: number
    page: number
    limit: number
    totalPages: number
  }> = {
    message: 'Lấy danh sách bạn bè để mời thành công',
    data: data as unknown as {
      friends: FriendToInviteChannel[]
      total: number
      page: number
      limit: number
      totalPages: number
    }
  }

  res.json(response)
}

export const requestJoinChannelController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params as { channelId: string }
  const { user_id } = req.decode_authorization as TokenPayload

  const result = await channelServices.requestJoinChannel(BigInt(channelId), BigInt(user_id))

  const response: ApiResponse<{
    channelId: string
    userId: string
    status: string
    createdAt: string
  }> = {
    message: 'Gửi yêu cầu tham gia channel thành công',
    data: result
  }

  res.status(httpStatus.CREATED).json(response)
}

export const cancelJoinRequestController = async (req: AuthenticatedRequest, res: Response) => {
  const { channelId } = req.params as { channelId: string }
  const { user_id } = req.decode_authorization as TokenPayload

  const result = await channelServices.cancelJoinRequest(BigInt(channelId), BigInt(user_id))

  const response: ApiResponse<{
    channelId: string
    userId: string
    status: string
  }> = {
    message: 'Hủy yêu cầu tham gia channel thành công',
    data: result
  }

  res.json(response)
}
