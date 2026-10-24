import Redis from 'ioredis'
import databaseServices from './database.services'
import { MemberStatus } from '~/constants/enum'
import { envConfig } from '~/utils/config'

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
  keyPrefix: 'chat:' // mọi key tự có prefix "chat:"
})

redis.on('connect', () => console.log('[Redis] connected'))
redis.on('error', (err) => console.error('[Redis] error:', err.message))

const MEMBER_TTL = 300 // 5 phút - key tự expire sau 5 phút
const WORKSPACE_TTL = 600 // 10 phút - workspace ít thay đổi

/**
 * Lấy danh sách userId là member của channel.
 *
 * Flow:
 * 1. Thử cache (Redis) trước
 * 2. Cache miss → query DB → lưu cache → trả về
 *
 * @returns Array userId. Trả [] nếu channel không có members.
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
    console.log(`[Cache HIT] ${key} → ${cached.length} members (0 query DB)`)
    return cached.map(Number) // Convert string[] → number[]
  }

  console.log(`[Cache MISS] ${key} → query DB...`)

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
    console.log(`[Cache SET] ${key} → ${userIds.length} members (TTL ${MEMBER_TTL}s)`)
  } else {
    console.log(`[Cache SKIP] ${key} → 0 members, không cache`)
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

  // 3. Ghi cache với TTL (set + expire trong 1 lệnh atomic)

  await redis.set(key, channel.workspaceId?.toString() ?? '0', 'EX', WORKSPACE_TTL)

  return Number(channel.workspaceId)
}

/**
 * Xoá cache khi membership thay đổi.
 * Gọi sau khi add/remove member.
 */
export const invalidateChannelMembers = async (channelId: bigint | string | number): Promise<void> => {
  const deleted = await redis.del(`channel:${String(channelId)}:members`)
  if (deleted > 0) {
    console.log(`[Cache INVALIDATE] channel:${channelId}:members → xoá ${deleted} key`)
  }
}

/**
 * Xoá cache khi channel.workspaceId thay đổi.
 * (Hiếm khi xảy ra, nhưng cần có để đảm bảo consistency)
 */
export const invalidateChannelWorkspace = async (channelId: number): Promise<void> => {
  await redis.del(`channel:${channelId}:workspace`)
}
