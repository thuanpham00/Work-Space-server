/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChannelMemberRole, ChannelType, WorkspaceInvitePolicy, WorkspaceMemberRole } from '~/constants/enum'
import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { ApproverType } from '~/generated/prisma/enums'
import { WorkspaceInviteStatus } from '~/generated/prisma/enums'
import { Channel } from '~/models/responses/channel.response'
import {
  type Workspace as WorkspaceResponse,
  type WorkspaceCategory,
  WorkspaceMemberStatus,
  type InviteSearchUserItem,
  type PaginatedInviteSearch,
  type InviteDenialReason
} from '~/models/responses/workspace.response'
import databaseServices from '~/services/database.services'
import { envConfig } from '~/utils/config'
import { buildFriendStatusMap, checkCanInvite, generateUniqueInviteCode } from '~/utils/utils'

class Workspace {
  async createWorkspaceForUser(userId: bigint) {
    await databaseServices.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name: 'Workspace mặc định',
          description: 'Workspace mặc định được tạo khi đăng ký tài khoản',
          ownerId: userId,
          categories: {
            create: [
              {
                name: 'Chung',
                position: 0,
                channels: {
                  create: [
                    {
                      name: 'general',
                      description: 'Kênh chung',
                      type: ChannelType.TEXT,
                      isPrivate: false,
                      isDefault: true,
                      members: {
                        create: [
                          {
                            userId: userId,
                            role: ChannelMemberRole.ADMIN,
                            joinedAt: new Date()
                          }
                        ]
                      }
                    },
                    {
                      name: 'announcements',
                      description: 'Kênh thông báo',
                      type: ChannelType.TEXT,
                      isPrivate: false,
                      isDefault: true,
                      members: {
                        create: [
                          {
                            userId: userId,
                            role: ChannelMemberRole.ADMIN,
                            joinedAt: new Date()
                          }
                        ]
                      }
                    },
                    {
                      name: 'random',
                      description: 'Kênh tán gẫu',
                      type: ChannelType.TEXT,
                      isPrivate: false,
                      isDefault: true,
                      members: {
                        create: [
                          {
                            userId: userId,
                            role: ChannelMemberRole.ADMIN,
                            joinedAt: new Date()
                          }
                        ]
                      }
                    }
                  ]
                }
              }
            ]
          },
          members: {
            create: [
              {
                userId: userId,
                role: WorkspaceMemberRole.OWNER,
                status: WorkspaceMemberStatus.ACTIVE,
                joinedAt: new Date(),
                acceptedAt: new Date(),
                approvedById: userId,
                approvedByType: ApproverType.USER
              }
            ]
          }
        },
        include: {
          categories: {
            include: {
              channels: true
            }
          }
        }
      })

      const code = await generateUniqueInviteCode(tx as any)
      await tx.workspaceInvite.create({
        data: {
          code,
          workspaceId: workspace.id,
          status: WorkspaceInviteStatus.ACTIVE,
          expiresAt: null,
          createdById: userId
        }
      })
    })
  }

  private getDataCategory(categoryData: any[]): WorkspaceCategory[] {
    return categoryData
      .sort((a, b) => a.position - b.position)
      .map((category) => ({
        ...category,
        id: category.id.toString(),
        workspaceId: category.workspaceId.toString(),
        name: category.name ? category.name : null,
        position: category.position,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
        channels: category.channels
          ? category.channels
              .sort((a: Channel, b: Channel) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
              .map((channel: Channel) => ({
                ...channel,
                id: channel.id.toString(),
                workspaceId: channel.workspaceId ? channel.workspaceId.toString() : null,
                categoryId: channel.categoryId ? channel.categoryId.toString() : null,
                name: channel.name ? channel.name : null,
                description: channel.description ? channel.description : null,
                type: channel.type ? channel.type : null,
                createdAt: channel.createdAt,
                updatedAt: channel.updatedAt
              }))
          : []
      }))
  }

  async getActiveInviteLink(workspaceId: bigint) {
    const invite = await databaseServices.prisma.workspaceInvite.findFirst({
      where: {
        workspaceId,
        status: WorkspaceInviteStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      }
    })

    if (!invite) {
      throw new ErrorWithStatus({
        message: 'Không tìm thấy link mời',
        status: httpStatus.NOTFOUND
      })
    }

    return {
      url: `${envConfig.frontend_url}/invite/${invite.code}`,
      expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null
    }
  }

  /**
   * Tạo link invite mới (OWNER/ADMIN).
   * - Revoke link ACTIVE cũ (nếu có) trước khi tạo mới → atomic.
   * - ttlSeconds: number = TTL giây; null = không hết hạn; undefined = mặc định 7 ngày.
   */
  async createInviteLink(workspaceId: bigint, userId: bigint, ttlSeconds?: number | null) {
    // Tính expiresAt
    let expiresAt: Date | null
    if (ttlSeconds === undefined) {
      // Mặc định 7 ngày
      expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    } else if (ttlSeconds === null) {
      expiresAt = null
    } else {
      expiresAt = new Date(Date.now() + ttlSeconds * 1000)
    }

    return await databaseServices.prisma.$transaction(async (tx) => {
      // 1. Revoke tất cả link ACTIVE của workspace
      await tx.workspaceInvite.updateMany({
        where: {
          workspaceId,
          status: WorkspaceInviteStatus.ACTIVE
        },
        data: {
          status: WorkspaceInviteStatus.REVOKED,
          revokedAt: new Date(),
          revokedById: userId
        }
      })

      // 2. Generate unique code
      const code = await generateUniqueInviteCode(tx as any)

      // 3. Tạo link ACTIVE mới
      return await tx.workspaceInvite.create({
        data: {
          code,
          workspaceId,
          status: WorkspaceInviteStatus.ACTIVE,
          expiresAt,
          createdById: userId
        }
      })
    })
  }

  /**
   * Thu hồi link invite (OWNER/ADMIN).
   * - Set status = REVOKED, không xóa row (giữ audit trail).
   */
  async revokeInviteLink(workspaceId: bigint, code: string, userId: bigint) {
    const invite = await databaseServices.prisma.workspaceInvite.findUnique({
      where: { code }
    })

    if (!invite || invite.workspaceId !== workspaceId) {
      throw new ErrorWithStatus({
        message: 'Không tìm thấy link mời',
        status: httpStatus.NOTFOUND
      })
    }

    if (invite.status === WorkspaceInviteStatus.REVOKED) {
      throw new ErrorWithStatus({
        message: 'Link đã được thu hồi trước đó',
        status: httpStatus.BAD_REQUESTED
      })
    }

    return await databaseServices.prisma.workspaceInvite.update({
      where: { code },
      data: {
        status: WorkspaceInviteStatus.REVOKED,
        revokedAt: new Date(),
        revokedById: userId
      }
    })
  }

  async getWorkspacesOfUser(userId: bigint): Promise<WorkspaceResponse[]> {
    const workspaces = await databaseServices.prisma.workspace.findMany({
      where: {
        OR: [{ ownerId: userId }, { members: { some: { userId, status: WorkspaceMemberStatus.ACTIVE } } }]
      },
      include: {
        categories: {
          include: {
            channels: true
          }
        }
      }
    })

    return workspaces.map((workspace) => {
      const categories = this.getDataCategory(workspace.categories)

      return {
        ...workspace,
        id: workspace.id.toString(),
        ownerId: workspace.ownerId ? workspace.ownerId.toString() : null,
        name: workspace.name ? workspace.name : null,
        description: workspace.description ? workspace.description : null,
        avatar: workspace.avatar ? workspace.avatar : null,
        createdAt: workspace.createdAt.toISOString(),
        updatedAt: workspace.updatedAt.toISOString(),
        categories
      }
    })
  }

  async getWorkspaceMembers(workspaceId: bigint, currentUserId: string, search: string, page: number, limit: number) {
    const keyword = search.trim()

    const me = await databaseServices.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: BigInt(currentUserId) } }
    })

    const isActiveMember = me && me.status === WorkspaceMemberStatus.ACTIVE

    if (!isActiveMember) {
      throw new ErrorWithStatus({
        message: 'Bạn không có quyền xem danh sách thành viên workspace này',
        status: httpStatus.FORBIDDEN
      })
    }

    const where: any = {
      workspaceId,
      status: WorkspaceMemberStatus.ACTIVE
    }

    if (keyword) {
      where.user = {
        OR: [
          { username: { contains: keyword, mode: 'insensitive' } },
          { fullName: { contains: keyword, mode: 'insensitive' } }
        ]
      }
    }

    const [members, total] = await Promise.all([
      databaseServices.prisma.workspaceMember.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              avatar: true,
              fullName: true
            }
          }
        },
        orderBy: { joinedAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit
      }),
      databaseServices.prisma.workspaceMember.count({ where })
    ])

    return {
      members: members.map((m) => ({
        id: m.user.id.toString(),
        username: m.user.username,
        avatar: m.user.avatar,
        fullName: m.user.fullName,
        role: m.role,
        joinedAt: m.joinedAt?.toISOString() ?? null
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  }

  async getWorkspaceRequests(workspaceId: bigint, currentUserId: string) {
    const me = await databaseServices.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: BigInt(currentUserId) } }
    })

    const isAdmin =
      me &&
      me.status === WorkspaceMemberStatus.ACTIVE &&
      (me.role === WorkspaceMemberRole.OWNER || me.role === WorkspaceMemberRole.ADMIN)

    if (!isAdmin) {
      throw new ErrorWithStatus({
        message: 'Bạn không có quyền xem danh sách lời mời / yêu cầu tham gia',
        status: httpStatus.FORBIDDEN
      })
    }

    const requests = await databaseServices.prisma.workspaceMember.findMany({
      where: {
        workspaceId,
        status: {
          in: [WorkspaceMemberStatus.PENDING_INVITE, WorkspaceMemberStatus.PENDING_REQUEST]
        }
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true,
            fullName: true
          }
        }
      },
      orderBy: { invitedAt: 'desc' }
    })

    const inviterIds = [...new Set(requests.map((r) => r.invitedById).filter((id): id is bigint => id !== null))]
    const inviters = inviterIds.length
      ? await databaseServices.prisma.user.findMany({
          where: { id: { in: inviterIds } },
          select: { id: true, displayName: true, username: true }
        })
      : []
    const inviterMap = new Map(inviters.map((u) => [u.id.toString(), u]))

    return requests.map((r) => {
      const inviter = r.invitedById ? inviterMap.get(r.invitedById.toString()) : null
      return {
        userId: r.user.id.toString(),
        username: r.user.username,
        avatar: r.user.avatar,
        fullName: r.user.fullName,
        role: r.role,
        type: r.status === WorkspaceMemberStatus.PENDING_INVITE ? 'invite' : 'join',
        invitedById: r.invitedById?.toString() ?? null,
        invitedByName: inviter?.displayName ?? inviter?.username ?? null,
        requestedById: r.requestedById?.toString() ?? null,
        invitedAt: r.invitedAt?.toISOString() ?? null,
        joinedAt: null
      }
    })
  }

  async getWorkSpaceDetail(workspaceId: bigint, userId: bigint): Promise<WorkspaceResponse | null> {
    const workspace = await databaseServices.prisma.workspace.findFirstOrThrow({
      where: {
        id: workspaceId
      },
      include: {
        categories: {
          include: {
            channels: true
          }
        }
      }
    })

    if (!workspace) {
      throw new ErrorWithStatus({
        message: 'Workspace không tồn tại',
        status: httpStatus.NOTFOUND
      })
    }

    const findMember = await databaseServices.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: {
        role: true
      }
    })

    if (!findMember) {
      throw new ErrorWithStatus({
        message: 'Bạn không thuộc workspace này',
        status: httpStatus.FORBIDDEN
      })
    }

    const categories = this.getDataCategory(workspace.categories)

    return {
      ...workspace,
      id: workspace.id.toString(),
      ownerId: workspace.ownerId ? workspace.ownerId.toString() : null,
      name: workspace.name ? workspace.name : null,
      description: workspace.description ? workspace.description : null,
      avatar: workspace.avatar ? workspace.avatar : null,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
      role: findMember.role as WorkspaceMemberRole,
      categories
    }
  }

  async getWorkspaceMemberStatus(workspaceId: bigint, userId: bigint) {
    const workspace = await databaseServices.prisma.workspace.findFirst({
      where: {
        id: workspaceId
      },
      include: {
        owner: true
      }
    })

    if (!workspace) return null

    const statusMemberWorkspace = await databaseServices.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId
      }
    })

    return {
      ...workspace,
      workspaceStatus: statusMemberWorkspace?.status || null
    }
  }

  /**
   * User gửi request xin join vào workspace
   * - status: PENDING_REQUEST (chờ duyệt)
   * - requestedById: id của user gửi request
   */
  async requestToJoinWorkspace(workspaceId: bigint, userId: bigint) {
    const workspace = await databaseServices.prisma.workspace.findUnique({
      where: { id: workspaceId }
    })

    if (!workspace) {
      throw new ErrorWithStatus({
        message: 'Workspace không tồn tại',
        status: httpStatus.NOTFOUND
      })
    }

    if (workspace.ownerId === userId) {
      throw new ErrorWithStatus({
        message: 'Bạn là owner của workspace này, không cần gửi yêu cầu tham gia',
        status: httpStatus.BAD_REQUESTED
      })
    }

    const existingMember = await databaseServices.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId
        }
      }
    })

    if (existingMember) {
      if (existingMember.status === 'ACTIVE') {
        throw new ErrorWithStatus({
          message: 'Bạn đã là thành viên của workspace này',
          status: httpStatus.BAD_REQUESTED
        })
      }
      if (existingMember.status === 'PENDING_REQUEST') {
        throw new ErrorWithStatus({
          message: 'Bạn đã gửi yêu cầu tham gia trước đó, vui lòng chờ duyệt',
          status: httpStatus.BAD_REQUESTED
        })
      }
      if (existingMember.status === 'PENDING_INVITE') {
        throw new ErrorWithStatus({
          message: 'Bạn đang có lời mời tham gia workspace này',
          status: httpStatus.BAD_REQUESTED
        })
      }
      if (
        existingMember.status === 'REJECTED' ||
        existingMember.status === 'LEFT' ||
        existingMember.status === 'CANCELLED'
      ) {
        const updatedMember = await databaseServices.prisma.workspaceMember.update({
          where: {
            workspaceId_userId: {
              workspaceId,
              userId
            }
          },
          data: {
            status: WorkspaceMemberStatus.PENDING_REQUEST,
            role: 'MEMBER',
            requestedById: userId,
            invitedById: null,
            approvedById: null,
            approvedByType: null,
            acceptedAt: null,
            rejectedAt: null,
            joinedAt: null
          }
        })

        return updatedMember
      }
    }

    // 4. Tạo bản ghi workspaceMember mới với status PENDING_REQUEST
    const newMember = await databaseServices.prisma.workspaceMember.create({
      data: {
        workspaceId,
        userId,
        role: 'MEMBER',
        status: WorkspaceMemberStatus.PENDING_REQUEST,
        requestedById: userId
      }
    })

    return newMember
  }

  /**
   * User rút yêu cầu tham gia workspace
   * - Chỉ có thể hủy khi status là PENDING_REQUEST
   * - Không được hủy nếu là PENDING_INVITE (phải từ chối invite)
   */
  async cancelJoinRequest(workspaceId: bigint, userId: bigint) {
    const existingMember = await databaseServices.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId
        }
      }
    })

    if (!existingMember) {
      throw new ErrorWithStatus({
        message: 'Bạn chưa có yêu cầu tham gia workspace này',
        status: httpStatus.NOTFOUND
      })
    }

    if (existingMember.status === WorkspaceMemberStatus.PENDING_INVITE) {
      throw new ErrorWithStatus({
        message: 'Bạn có lời mời tham gia workspace này, không thể hủy yêu cầu. Vui lòng từ chối lời mời.',
        status: httpStatus.BAD_REQUESTED
      })
    }

    if (existingMember.status !== WorkspaceMemberStatus.PENDING_REQUEST) {
      throw new ErrorWithStatus({
        message: 'Không thể hủy yêu cầu tham gia vì trạng thái không hợp lệ',
        status: httpStatus.BAD_REQUESTED
      })
    }

    const updatedMember = await databaseServices.prisma.workspaceMember.update({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId
        }
      },
      data: {
        status: WorkspaceMemberStatus.CANCELLED,
        requestedById: null
      }
    })

    return updatedMember
  }

  async searchUsersToInvite(params: {
    workspaceId: bigint
    currentUserId: string
    searchTerm: string
    page: number
    limit: number
  }): Promise<PaginatedInviteSearch> {
    const { workspaceId, currentUserId, searchTerm, page, limit } = params
    const meIdBig = BigInt(currentUserId)
    const skip = (page - 1) * limit

    const me = await databaseServices.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: meIdBig } }
    })

    const isActiveMember = me && me.status === WorkspaceMemberStatus.ACTIVE
    if (!isActiveMember) {
      throw new ErrorWithStatus({
        message: 'Bạn không phải thành viên của workspace này',
        status: httpStatus.FORBIDDEN
      })
    }

    // 2. Build where clause tìm users
    const userWhere: any = { id: { not: meIdBig } }
    if (searchTerm) {
      userWhere.OR = [
        { username: { contains: searchTerm, mode: 'insensitive' } },
        { fullName: { contains: searchTerm, mode: 'insensitive' } }
      ]
    }

    // 3. Query users + count song song
    const [totalUsers, users] = await Promise.all([
      databaseServices.prisma.user.count({ where: userWhere }),
      databaseServices.prisma.user.findMany({
        where: userWhere,
        skip,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          username: true,
          displayName: true,
          fullName: true,
          avatar: true
        }
      })
    ])

    if (users.length === 0) {
      return {
        items: [],
        total: totalUsers,
        page,
        limit,
        totalPages: Math.ceil(totalUsers / limit)
      }
    }

    const userIds = users.map((u) => u.id)

    const [friendStatusMap, settings, existingMembers] = await Promise.all([
      buildFriendStatusMap(currentUserId, userIds),
      databaseServices.prisma.userSetting.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, workspaceInvitePolicy: true }
      }),
      databaseServices.prisma.workspaceMember.findMany({
        where: { workspaceId, userId: { in: userIds } },
        select: { userId: true, status: true }
      })
    ])

    // Build map O(1)
    const policyMap = new Map<string, WorkspaceInvitePolicy | null>()
    for (const s of settings) {
      policyMap.set(s.userId.toString(), s.workspaceInvitePolicy as WorkspaceInvitePolicy | null)
    }

    const memberStatusMap = new Map<string, WorkspaceMemberStatus>()
    for (const m of existingMembers) {
      memberStatusMap.set(m.userId.toString(), m.status as WorkspaceMemberStatus)
    }

    // 5. Combine + check canInvite
    const items: InviteSearchUserItem[] = users.map((user) => {
      const uid = user.id.toString()
      const friendStatus = friendStatusMap.get(uid) ?? null
      const policy = policyMap.get(uid) ?? null
      const existingStatus = memberStatusMap.get(uid) ?? null

      const { canInvite, reason } = checkCanInvite({
        inviterId: meIdBig,
        inviteeId: user.id,
        inviteePolicy: policy,
        friendStatus,
        existingWorkspaceStatus: existingStatus
      })

      return {
        id: uid,
        username: user.username,
        displayName: user.displayName,
        fullName: user.fullName,
        avatar: user.avatar,
        friendStatus,
        workspaceInvitePolicy: policy,
        existingWorkspaceStatus: existingStatus,
        canInvite,
        reason: reason as InviteDenialReason
      }
    })

    return {
      items,
      total: totalUsers,
      page,
      limit,
      totalPages: Math.ceil(totalUsers / limit)
    }
  }

  /**
   * Admin/Owner mời user vào workspace
   * - status: PENDING_INVITE
   * - role: MEMBER (default)
   * - invitedById: id của admin/owner gửi lời mời
   * - Validate bằng checkCanInvite (self-invite, already member, policy, friend)
   */
  async inviteUserToWorkspace(workspaceId: bigint, inviterId: bigint, inviteeId: bigint) {
    const workspace = await databaseServices.prisma.workspace.findUnique({
      where: { id: workspaceId }
    })
    if (!workspace) {
      throw new ErrorWithStatus({
        message: 'Workspace không tồn tại',
        status: httpStatus.NOTFOUND
      })
    }

    const invitee = await databaseServices.prisma.user.findUnique({
      where: { id: inviteeId }
    })
    if (!invitee) {
      throw new ErrorWithStatus({
        message: 'Người dùng không tồn tại',
        status: httpStatus.NOTFOUND
      })
    }

    // 3. Lấy existing member status
    const existingMember = await databaseServices.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: inviteeId } }
    })

    // 4. Lấy friendStatus + policy để checkCanInvite
    const friendStatus = await databaseServices.prisma.friend.findFirst({
      where: {
        OR: [
          { requesterId: inviterId, addresseeId: inviteeId },
          { requesterId: inviteeId, addresseeId: inviterId }
        ]
      },
      select: { status: true }
    })

    const setting = await databaseServices.prisma.userSetting.findUnique({
      where: { userId: inviteeId },
      select: { workspaceInvitePolicy: true }
    })

    // 5. Check quyền được mời
    const { canInvite, reason } = checkCanInvite({
      inviterId,
      inviteeId,
      inviteePolicy: (setting?.workspaceInvitePolicy as WorkspaceInvitePolicy) ?? null,
      friendStatus: (friendStatus?.status as any) ?? null,
      existingWorkspaceStatus: (existingMember?.status as WorkspaceMemberStatus) ?? null
    })

    if (!canInvite) {
      const messageMap: Record<string, string> = {
        SELF_INVITE: 'Bạn không thể tự mời chính mình',
        ALREADY_MEMBER: 'Người dùng này đã là thành viên workspace',
        ALREADY_PENDING_INVITE: 'Người dùng này đang có lời mời pending',
        ALREADY_PENDING_REQUEST: 'Người dùng này đang có yêu cầu tham gia pending',
        FRIENDS_ONLY_POLICY: 'Người dùng này chỉ nhận lời mời từ bạn bè',
        NO_FRIEND_REQUEST: 'Bạn cần kết bạn trước khi mời'
      }
      throw new ErrorWithStatus({
        message: messageMap[reason as string] ?? 'Không thể mời người dùng này',
        status: httpStatus.BAD_REQUESTED
      })
    }

    // 6. Nếu đã REJECTED/LEFT/CANCELLED -> update; nếu chưa có -> create
    if (existingMember) {
      // status là REJECTED/LEFT/CANCELLED -> reset về PENDING_INVITE
      const updatedMember = await databaseServices.prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: inviteeId } },
        data: {
          status: WorkspaceMemberStatus.PENDING_INVITE,
          role: WorkspaceMemberRole.MEMBER,
          invitedById: inviterId,
          invitedAt: new Date(),
          requestedById: null,
          approvedById: null,
          approvedByType: null,
          acceptedAt: null,
          rejectedAt: null,
          joinedAt: null
        }
      })
      return updatedMember
    }

    // Chưa có record -> tạo mới
    const newMember = await databaseServices.prisma.workspaceMember.create({
      data: {
        workspaceId,
        userId: inviteeId,
        status: WorkspaceMemberStatus.PENDING_INVITE,
        role: WorkspaceMemberRole.MEMBER,
        invitedById: inviterId,
        invitedAt: new Date()
      }
    })

    return newMember
  }

  /**
   * Admin/Owner hủy lời mời đã gửi
   * - Chỉ hủy được khi status = PENDING_INVITE
   * - Update status -> CANCELLED, clear invitedById
   */
  async cancelInvite(workspaceId: bigint, inviterId: bigint, inviteeId: bigint) {
    const existingMember = await databaseServices.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: inviteeId } }
    })

    if (!existingMember) {
      throw new ErrorWithStatus({
        message: 'Không tìm thấy lời mời để hủy',
        status: httpStatus.NOTFOUND
      })
    }

    if (existingMember.status !== WorkspaceMemberStatus.PENDING_INVITE) {
      throw new ErrorWithStatus({
        message: 'Không thể hủy lời mời vì trạng thái không hợp lệ',
        status: httpStatus.BAD_REQUESTED
      })
    }

    const updatedMember = await databaseServices.prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: inviteeId } },
      data: {
        status: WorkspaceMemberStatus.CANCELLED,
        invitedById: null,
        invitedAt: null
      }
    })

    return updatedMember
  }
}

export default new Workspace()
