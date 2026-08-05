/**
 * Helper kiểm tra quyền tham gia của 2 user trong 1 channel/cuộc trò chuyện.
 *
 * Phase 1 chỉ dùng cho DM (ChannelType.DM); nếu mở rộng sau có thể hỗ trợ
 * channel nhiều người hoặc group call.
 *
 * Trả về thông tin channel + member để caller có thể đính kèm vào payload gửi tới receiver.
 */

import { ChannelType } from '~/constants/enum'
import databaseServices from '~/services/database.services'

export type ConversationMember = {
  id: string
  name: string
  avatar: string | null
}

export type ConversationParticipantCheck = {
  channelId: string
  caller: ConversationMember | null
  receiver: ConversationMember | null
}

export const ensureConversationParticipants = async (params: {
  channelId: string
  callerId: string
  receiverId: string
}): Promise<ConversationParticipantCheck | null> => {
  const { channelId, callerId, receiverId } = params

  let channelBigInt: bigint
  try {
    channelBigInt = BigInt(channelId)
  } catch {
    return null
  }

  if (callerId === receiverId) return null

  const channel = await databaseServices.prisma.channel.findFirst({
    where: {
      id: channelBigInt,
      type: ChannelType.DM,
      AND: [{ members: { some: { userId: BigInt(callerId) } } }, { members: { some: { userId: BigInt(receiverId) } } }]
    },
    include: {
      members: {
        include: {
          user: {
            select: {
              id: true,
              displayName: true,
              username: true,
              avatar: true,
              fullName: true
            }
          }
        }
      }
    }
  })

  if (!channel) return null

  const toMember = (id: string): ConversationMember | null => {
    const m = channel.members.find((member) => member.userId.toString() === id)
    if (!m) return null
    const u = m.user
    return {
      id: u.id.toString(),
      name: u.displayName ?? u.username ?? u.fullName ?? u.id.toString(),
      avatar: u.avatar ?? null
    }
  }

  return {
    channelId: channel.id.toString(),
    caller: toMember(callerId),
    receiver: toMember(receiverId)
  }
}

/**
 * Kiểm tra 1 user có thuộc channel hay không; dùng cho accept/reject/end nếu muốn chặt.
 */
export const isChannelMember = async (channelId: string, userId: string): Promise<boolean> => {
  try {
    const count = await databaseServices.prisma.channelMember.count({
      where: {
        channelId: BigInt(channelId),
        userId: BigInt(userId)
      }
    })
    return count > 0
  } catch {
    return false
  }
}
