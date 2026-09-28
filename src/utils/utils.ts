import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { envConfig } from '~/utils/config'
import { verifyToken } from '~/utils/jwt'
import { Request } from 'express'
import { JsonWebTokenError } from 'jsonwebtoken'
import { FriendStatus, FriendStatusRequest, WorkspaceInvitePolicy } from '~/constants/enum'
import databaseServices from '~/services/database.services'
import { WorkspaceMemberStatus } from '~/models/responses/workspace.response'
import { randomBytes } from 'crypto'
import { PrismaClient } from '~/generated/prisma/client'

export const verifyAccessToken = async (access_token: string, req?: Request) => {
  if (!access_token) {
    throw new ErrorWithStatus({
      message: 'AccessToken bắt buộc!',
      status: httpStatus.UNAUTHORIZED
    })
  }
  try {
    const decode_authorization = await verifyToken({
      token: access_token,
      privateKey: envConfig.secret_key_access_token
    })
    if (req) {
      req.decode_authorization = decode_authorization
      return true
    }
    return decode_authorization
  } catch (error) {
    if (error instanceof JsonWebTokenError) {
      throw new ErrorWithStatus({
        message: 'AccessToken expired',
        status: httpStatus.UNAUTHORIZED
      })
    }
  }
}

export const normalizeSearchParams = (
  page: string | undefined,
  limit: string | undefined,
  search: string | undefined,
  options: { defaultLimit?: number; maxLimit?: number } = {}
) => {
  const defaultLimit = options.defaultLimit ?? 10
  const maxLimit = options.maxLimit ?? 100

  const pageNumber = Math.max(Number(page) || 1, 1)
  const rawLimit = Number(limit) || defaultLimit
  const limitNumber = Math.min(Math.max(rawLimit, 1), maxLimit)
  const searchTerm = (search ?? '').trim()

  return {
    pageNumber,
    limitNumber,
    skip: (pageNumber - 1) * limitNumber,
    searchTerm
  }
}

export const buildFriendStatusMap = async (
  meId: string,
  otherUserIds: bigint[]
): Promise<Map<string, FriendStatusRequest | null>> => {
  const map = new Map<string, FriendStatusRequest | null>()
  if (otherUserIds.length === 0) return map

  const friendships = await databaseServices.prisma.friend.findMany({
    where: {
      OR: [
        { requesterId: BigInt(meId), addresseeId: { in: otherUserIds } },
        { requesterId: { in: otherUserIds }, addresseeId: BigInt(meId) }
      ]
    },
    select: {
      status: true,
      requesterId: true,
      addresseeId: true
    }
  })

  for (const id of otherUserIds) {
    map.set(id.toString(), null)
  }

  for (const f of friendships) {
    const otherId = f.requesterId === BigInt(meId) ? f.addresseeId : f.requesterId

    if (f.status === FriendStatus.ACCEPTED) {
      map.set(otherId.toString(), FriendStatusRequest.ACCEPTED)
    } else if (f.status === FriendStatus.PENDING) {
      map.set(
        otherId.toString(),
        f.requesterId === BigInt(meId) ? FriendStatusRequest.REQUEST_SENT : FriendStatusRequest.REQUEST_RECEIVED
      )
    }
  }

  return map
}

export const buildWorkspaceMemberMap = async (meId: bigint, otherWorkspaceIds: bigint[]) => {
  const existingMember = await databaseServices.prisma.workspaceMember.findMany({
    where: {
      workspaceId: {
        in: otherWorkspaceIds.map((w) => w)
      },
      userId: BigInt(meId)
    },
    select: {
      status: true,
      workspaceId: true
    }
  })

  const workspaceMemberMap = new Map<string, WorkspaceMemberStatus>()
  for (const member of existingMember) {
    workspaceMemberMap.set(member.workspaceId.toString(), member.status as WorkspaceMemberStatus)
  }

  return workspaceMemberMap
}

/**
 * Check xem `inviterId` có thể mời `inviteeId` vào 1 workspace hay không.
 *
 * Quy tắc (theo thứ tự ưu tiên):
 * 1. Không thể tự mời chính mình
 * 2. Nếu đã là ACTIVE member -> không mời
 * 3. Nếu đã có PENDING_INVITE -> không mời (đợi user accept/reject)
 * 4. Nếu đã có PENDING_REQUEST -> không mời (user đã gửi request rồi)
 * 5. Nếu inviteePolicy = FRIENDS_ONLY -> chỉ mời được khi là bạn (ACCEPTED)
 *    - Nếu đã là bạn -> OK
 *    - Nếu đã có REQUEST_SENT / REQUEST_RECEIVED -> OK (đang pending, coi như đủ điều kiện)
 *    - Nếu không có quan hệ friend -> từ chối (FRIENDS_ONLY_POLICY)
 * 6. EVERYONE -> luôn OK
 */
export const checkCanInvite = (params: {
  inviterId: bigint
  inviteeId: bigint
  inviteePolicy: WorkspaceInvitePolicy | null
  friendStatus: FriendStatusRequest | null
  existingWorkspaceStatus: WorkspaceMemberStatus | null
}): { canInvite: boolean; reason: string } => {
  const { inviterId, inviteeId, inviteePolicy, friendStatus, existingWorkspaceStatus } = params

  // 1. Tự mời chính mình
  if (inviterId === inviteeId) {
    return { canInvite: false, reason: 'SELF_INVITE' }
  }

  // 2. Đã là member
  if (existingWorkspaceStatus === WorkspaceMemberStatus.ACTIVE) {
    return { canInvite: false, reason: 'ALREADY_MEMBER' }
  }

  // 3. Đã có lời mời đang pending
  if (existingWorkspaceStatus === WorkspaceMemberStatus.PENDING_INVITE) {
    return { canInvite: false, reason: 'ALREADY_PENDING_INVITE' }
  }

  // 4. Đã có request xin join đang pending
  if (existingWorkspaceStatus === WorkspaceMemberStatus.PENDING_REQUEST) {
    return { canInvite: false, reason: 'ALREADY_PENDING_REQUEST' }
  }

  // 5. Check policy của NGƯỜI ĐƯỢC MỜI
  if (inviteePolicy === WorkspaceInvitePolicy.FRIENDS_ONLY) {
    const isAccepted = friendStatus === FriendStatusRequest.ACCEPTED
    const isPendingFriend =
      friendStatus === FriendStatusRequest.REQUEST_SENT || friendStatus === FriendStatusRequest.REQUEST_RECEIVED

    if (!isAccepted && !isPendingFriend) {
      return { canInvite: false, reason: 'FRIENDS_ONLY_POLICY' }
    }
  }

  return { canInvite: true, reason: 'OK' }
}

/**
 * Generate mã invite code ngẫu nhiên, dùng cho `WorkspaceInvite.code`.
 *
 * - Alphabet: chỉ gồm chữ + số, bỏ các ký tự dễ nhầm (0/O, 1/I/l) để user đọc dễ.
 * - Dùng `crypto.randomBytes` (Node built-in) thay cho `nanoid` để tránh thêm dependency.
 * - Độ dài 10 ký tự → không gian 51^10 ≈ 1.19e17, đủ rộng để không va chạm trong workspace.
 * - Check unique trong DB với tối đa `maxRetries` lần (mặc định 5).
 */
export async function generateUniqueInviteCode(
  prisma: PrismaClient | { workspaceInvite: { findUnique: (args: { where: { code: string } }) => Promise<unknown> } },
  maxRetries = 5
): Promise<string> {
  // Bỏ 0/O, 1/I/l để tránh nhầm lẫn khi đọc/nhập
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz'
  const len = 10

  for (let i = 0; i < maxRetries; i++) {
    // randomBytes đủ lớn → lấy byte, mod theo alphabet length, map sang ký tự
    const bytes = randomBytes(len)
    let code = ''
    for (let j = 0; j < len; j++) {
      code += alphabet[bytes[j] % alphabet.length]
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exists = await (prisma as any).workspaceInvite.findUnique({ where: { code } })
    if (!exists) return code
  }

  throw new Error('Failed to generate unique invite code')
}
