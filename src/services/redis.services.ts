import Redis from 'ioredis'
import databaseServices from './database.services'
import { ChannelType, MemberStatus, MessageType } from '~/constants/enum'
import { envConfig, REDIS_KEY_PREFIX } from '~/utils/config'

/**
 * 8h sáng:  50 members x 20 msg x 60 phút = 60,000 query DB trong 1 giờ
Cả ngày:  ~500,000 query DB chỉ để lấy members
→ DB load tăng, response chậm, tốn tiền Supabase

=>>>

8h sáng:  Lần đầu tiên miss → query DB 1 lần
          5 phút sau TTL hết → query lại 1 lần
          → Tổng 1 giờ: ~12 query DB cho 1 user
Cả ngày:  ~100 query DB cho 1 user
→ Giảm 5,000 lần query. DB thở phào.
 */

// ============ KẾT NỐI REDIS ============
export const redis = new Redis(envConfig.redis_url, {
  keyPrefix: REDIS_KEY_PREFIX // mọi key tự có prefix "chat:"
})

redis.on('connect', () => console.log('[Redis] connected'))
redis.on('error', (err) => console.error('[Redis] error:', err.message))

const MEMBER_TTL = 300 // 5 phút - key tự expire sau 5 phút
const WORKSPACE_TTL = 600 // 10 phút - workspace ít thay đổi
const LATEST_MESSAGE_TTL = 300 // 5 phút - message mới nhất thay đổi liên tục khi có tin
const NO_WORKSPACE = '__none__'

/**
 * Lấy danh sách userId là member của channel.
 *
 * Flow:
 * 1. Thử cache (Redis) trước
 * 2. Cache miss → query DB → lưu cache → trả về
 *
 *  Key:    chat:channel:10:members
    Type:   Set
    Members: ["15", "20", "30"]   (chuỗi, vì Redis không có number)
 */
export const getChannelMemberIds = async (channelId: string): Promise<number[]> => {
  const key = `channel:${channelId}:members`

  // 1. Thử cache
  const cached = await redis.smembers(key)
  if (cached.length > 0) {
    return cached.map(Number) // Convert string[] → number[]
  }

  // 2. Cache miss → query DB
  const members = await databaseServices.prisma.channelMember.findMany({
    where: {
      channelId: BigInt(channelId),
      status: MemberStatus.ACTIVE
    },
    select: {
      userId: true
    }
  })

  const userIds = members.map((m) => m.userId)

  // 3. Ghi cache (chỉ khi có members)
  if (userIds.length > 0) {
    await redis.sadd(key, ...userIds.map(String)) // Convert number → string
    await redis.expire(key, MEMBER_TTL) // Set TTL
  }

  return userIds.map((id) => Number(id))
}

/**
 * 
 *  Key:    chat:channel:10:workspace
    Type:   String
    Value:  "5"   (chuỗi, Redis không có number riêng)
 */

export const getChannelWorkspaceId = async (channelId: string): Promise<number | null> => {
  const key = `channel:${channelId}:workspace`

  // 1. Thử cache trước
  const cached = await redis.get(key)
  if (cached !== null) {
    if (cached === NO_WORKSPACE) return null
    return Number(cached) // Convert string → number
  }

  // 2. Cache miss → query DB
  const channel = await databaseServices.prisma.channel.findFirst({
    where: {
      id: BigInt(channelId)
    },
    select: { workspaceId: true }
  })
  if (!channel) return null

  if (channel.workspaceId === null) {
    await redis.set(key, NO_WORKSPACE, 'EX', WORKSPACE_TTL)
    return null
  }

  // 3. Ghi cache với TTL (set + expire trong 1 lệnh atomic)
  await redis.set(key, channel.workspaceId.toString(), 'EX', WORKSPACE_TTL)

  return Number(channel.workspaceId)
}

export const getChannelType = async (channelId: string): Promise<ChannelType | null> => {
  const key = `channel:${channelId}:type`

  // 1. Thử cache trước
  const cached = await redis.get(key)
  if (cached !== null) {
    return cached as ChannelType
  }

  // 2. Cache miss → query DB
  const channel = await databaseServices.prisma.channel.findFirst({
    where: {
      id: BigInt(channelId)
    },
    select: { type: true }
  })
  if (!channel) return null

  await redis.set(key, channel.type as string, 'EX', WORKSPACE_TTL)
  return channel.type as ChannelType
}

export const getChannelLatestMessageId = async (channelId: string): Promise<bigint | null> => {
  const key = `channel:${channelId}:latestMessage`

  // 1. Thử cache
  const cached = await redis.get(key)
  if (cached !== null) {
    return BigInt(cached)
  }

  // 2. Cache miss → query DB
  const message = await databaseServices.prisma.message.findFirst({
    where: {
      channelId: BigInt(channelId),
      messageType: { not: MessageType.CONFIG }
    },
    orderBy: { id: 'desc' },
    select: { id: true }
  })
  if (!message) return null

  // 3. Ghi cache (set + expire atomic)
  await redis.set(key, message.id.toString(), 'EX', LATEST_MESSAGE_TTL)

  return message.id
}

/**
 * Xoá cache latest message khi có message mới trong channel.
 * Gọi sau khi tạo message.
 */
export const invalidateChannelLatestMessage = async (channelId: string | number): Promise<void> => {
  await redis.del(`channel:${String(channelId)}:latestMessage`)
}

/**
 * Xoá cache khi membership thay đổi.
 * Gọi sau khi add/remove member.
 */
export const invalidateChannelMembers = async (channelId: bigint | string | number): Promise<void> => {
  await redis.del(`channel:${String(channelId)}:members`)
}

/**
 * Xoá cache khi channel.workspaceId thay đổi.
 * (Hiếm khi xảy ra, nhưng cần có để đảm bảo consistency)
 */
export const invalidateChannelWorkspace = (channelId: number): Promise<number> => {
  return redis.del(`channel:${channelId}:workspace`)
}
