import { MessageType } from '~/constants/enum'
import databaseServices from '~/services/database.services'

export const getUnreadCounts = async (channelId: number, userIds: number[]): Promise<Map<number, number>> => {
  const result = new Map<number, number>()
  if (userIds.length === 0) return result

  const bigChannelId = BigInt(channelId)

  // 1. Lấy read state của tất cả user (1 query)
  const readStates = await databaseServices.prisma.channelReadState.findMany({
    where: {
      channelId: bigChannelId,
      userId: { in: userIds.map((id) => BigInt(id)) }
    },
    select: {
      userId: true,
      lastReadMessageId: true
    }
  })

  // 2. Map userId → cutoff (user chưa có read state → cutoff = 0 → count = toàn bộ message)
  const cutoffMap = new Map<number, bigint>()
  for (const state of readStates) {
    cutoffMap.set(Number(state.userId), state.lastReadMessageId ?? BigInt(0))
  }

  // User KHÔNG có read state (chưa vào channel lần nào) → cutoff = 0.
  // Phải thêm vào cutoffMap TRƯỚC khi gom distinct cutoff, nếu không:
  //   - '0' không có trong `cutoffs` → không có count query cho cutoff 0
  //   → countByCutoff.get('0') = undefined → count = 0 (SAI, phải là toàn bộ message)
  for (const userId of userIds) {
    if (!cutoffMap.has(userId)) {
      cutoffMap.set(userId, BigInt(0))
    }
  }

  // 3. Gom distinct cutoff.
  // Dùng string vì BigInt so sánh bằng === theo tham chiếu, không theo giá trị
  // → Set<string> mới gom trùng đúng cách.
  const cutoffs = new Set<string>()
  for (const cutoff of cutoffMap.values()) {
    cutoffs.add(cutoff.toString())
  }

  // 4. 1 count query cho mỗi distinct cutoff (thường chỉ 1–3)
  const countByCutoff = new Map<string, number>()
  await Promise.all(
    [...cutoffs].map(async (cutoffStr) => {
      const count = await databaseServices.prisma.message.count({
        where: {
          channelId: bigChannelId,
          id: { gt: BigInt(cutoffStr) },
          messageType: { not: MessageType.CONFIG }
        }
      })
      countByCutoff.set(cutoffStr, count)
    })
  )

  // 5. Trả về map userId → count
  for (const userId of userIds) {
    const cutoff = cutoffMap.get(userId) ?? BigInt(0)
    result.set(userId, countByCutoff.get(cutoff.toString()) ?? 0)
  }

  return result
}
