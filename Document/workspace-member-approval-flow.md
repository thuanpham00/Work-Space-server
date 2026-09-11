# Kế Hoạch Triển Khai: Workspace Member Approval Flow

> Tài liệu tổng hợp các API cần triển khai cho hệ thống duyệt thành viên workspace
> **Phiên bản:** 3.0 - Phân chia theo phase triển khai thực tế
> **Ngày cập nhật:** 2026-09-11
> **Dựa trên:** `prisma/schema.prisma` (đã cập nhật)

---

## 📑 Mục Lục

- [Phase 0: Chuẩn bị](#phase-0-chuẩn-bị)
- [Phase 1: Admin Mời User](#phase-1-admin-mời-user-invite-flow)
- [Phase 2: User Accept / Reject Invite](#phase-2-user-xử-lý-invite)
- [Phase 3: User Xin Vào Workspace](#phase-3-user-xin-vào-workspace-request-flow)
- [Phase 4: Admin Duyệt Request](#phase-4-admin-duyệt-request)
- [Phase 5: Auto-Join Channel Default](#phase-5-auto-join-channel-default)
- [Phase 6: Quản lý Pending](#phase-6-quản-lý-pending-cancel--expire)
- [Phase 7: Member Management](#phase-7-member-management-active--left)
- [Tổng hợp API](#tổng-hợp-api)

---

## 🎯 Luồng Tổng Thể

```
                    ┌──────────────────────────┐
                    │     WORKSPACE            │
                    │      (Server)            │
                    └──────────┬───────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                  │
            ▼                  ▼                  ▼
    ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
    │  HƯỚNG 1    │    │   HƯỚNG 2    │    │  HƯỚNG 3     │
    │ Admin mời   │    │ User xin vào │    │ Auto-join    │
    └─────────────┘    └──────────────┘    └──────────────┘
            │                  │
            ▼                  ▼
    ┌──────────────┐    ┌──────────────┐
    │ PENDING_     │    │ PENDING_     │
    │ INVITE       │    │ REQUEST      │
    └──────────────┘    └──────────────┘
            │                  │
       User accept        Admin approve
            │                  │
            └────────┬─────────┘
                     ▼
              ┌──────────────┐
              │   ACTIVE     │
              │ (Auto-join   │
              │  channel)    │
              └──────────────┘
```

---

## Phase 0: Chuẩn Bị

> **Mục tiêu:** Setup DB & base utilities

### 0.1 Database Schema (đã có)

```prisma
enum WorkspaceMemberStatus {
  PENDING_INVITE   // Admin mời, chờ user
  PENDING_REQUEST  // User xin, chờ admin
  ACTIVE           // Hoạt động
  REJECTED         // Bị từ chối
  LEFT             // Đã rời
  CANCELLED        // Bị hủy
}

enum ApproverType {
  ADMIN  // Admin duyệt
  USER   // User accept
}
```

### 0.2 Files cần tạo

```
src/
├── types/
│   └── workspaceMember.types.ts   # TypeScript types
├── utils/
│   └── workspaceMember.util.ts    # Helper functions
│       ├── generateExpiryDate()
│       └── validateStatusTransition()
├── repositories/
│   └── workspaceMember.repo.ts    # Prisma queries
└── services/
    └── workspaceMember.services.ts # Business logic (sau)
```

### 0.3 Constants cần define

```typescript
// src/constants/workspaceMember.constant.ts
export const WORKSPACE_INVITE_EXPIRY_DAYS = 7;
export const WORKSPACE_REQUEST_EXPIRY_DAYS = 7;
```

---

## Phase 1: Admin Mời User (Invite Flow)

> **Mục tiêu:** Admin/Owner có thể gửi lời mời vào workspace

### 1.1 API cần triển khai

| # | Method | Endpoint | Mô tả |
|---|--------|----------|-------|
| 1.1 | `POST` | `/api/workspaces/:workspaceId/invitations` | Admin gửi lời mời cho 1 user |

### 1.2 Schema Input

```typescript
// src/models/schemas/invitation.schema.ts
export const createInvitationSchema = z.object({
  userId: z.bigint(),                    // User được mời
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
  message: z.string().max(500).optional(), // Lời nhắn kèm theo
  expiresInDays: z.number().int().min(1).max(30).default(7),
});
```

### 1.3 Service Logic

```typescript
async function createInvitation(workspaceId, adminId, dto) {
  // 1. Check admin permission (role in [OWNER, ADMIN])
  await validateAdminPermission(workspaceId, adminId);

  // 2. Check user tồn tại
  const user = await prisma.user.findUnique({ where: { id: dto.userId } });
  if (!user) throw new AppError(404, 'USER_NOT_FOUND');

  // 3. Check user chưa là member (status != ACTIVE)
  const existing = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: dto.userId } }
  });
  if (existing?.status === 'ACTIVE') {
    throw new AppError(409, 'ALREADY_MEMBER');
  }

  // 4. Upsert WorkspaceMember
  const member = await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId: dto.userId } },
    create: {
      workspaceId,
      userId: dto.userId,
      role: dto.role,
      status: 'PENDING_INVITE',
      invitedById: adminId,
      invitedAt: new Date(),
      expiresAt: addDays(new Date(), dto.expiresInDays),
      inviteMessage: dto.message,
    },
    update: {
      status: 'PENDING_INVITE',
      invitedById: adminId,
      invitedAt: new Date(),
      expiresAt: addDays(new Date(), dto.expiresInDays),
      inviteMessage: dto.message,
      // Reset các field duyệt
      acceptedAt: null,
      rejectedAt: null,
      approvedById: null,
    }
  });

  // 5. Gửi notification (Phase phụ)
  await sendNotification(dto.userId, {
    type: 'WORKSPACE_INVITATION',
    workspaceId,
    invitationId: `${workspaceId}_${dto.userId}`,
  });

  return member;
}
```

### 1.4 Output

```typescript
{
  workspaceId: bigint;
  userId: bigint;
  status: 'PENDING_INVITE';
  role: 'MEMBER' | 'ADMIN';
  invitedAt: Date;
  expiresAt: Date;
  inviteMessage: string | null;
}
```

---

## Phase 2: User Xử Lý Invite

> **Mục tiêu:** User được mời accept hoặc reject lời mời

### 2.1 API cần triển khai

| # | Method | Endpoint | Mô tả |
|---|--------|----------|-------|
| 2.1 | `GET` | `/api/users/me/workspace-invitations` | User xem tất cả lời mời pending của mình |
| 2.2 | `POST` | `/api/workspaces/:workspaceId/invitations/accept` | User chấp nhận lời mời |
| 2.3 | `POST` | `/api/workspaces/:workspaceId/invitations/reject` | User từ chối lời mời |

### 2.2 API 2.1: List My Invitations

```typescript
// GET /api/users/me/workspace-invitations
async function listMyInvitations(userId) {
  return prisma.workspaceMember.findMany({
    where: {
      userId,
      status: 'PENDING_INVITE',
      expiresAt: { gt: new Date() }  // Chỉ lấy cái chưa hết hạn
    },
    include: {
      workspace: {
        select: {
          id: true,
          name: true,
          avatar: true,
          description: true,
        }
      },
      invitedBy: {
        select: {
          id: true,
          displayName: true,
          avatar: true,
          username: true
        }
      }
    },
    orderBy: { invitedAt: 'desc' }
  });
}
```

### 2.3 API 2.2: Accept Invitation

```typescript
// POST /api/workspaces/:workspaceId/invitations/accept
async function acceptInvitation(workspaceId, userId) {
  // 1. Tìm invitation
  const invite = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } }
  });

  // 2. Validate
  if (!invite) throw new AppError(404, 'INVITATION_NOT_FOUND');
  if (invite.status !== 'PENDING_INVITE') {
    throw new AppError(409, 'INVITATION_NOT_PENDING');
  }
  if (invite.expiresAt && invite.expiresAt < new Date()) {
    throw new AppError(410, 'INVITATION_EXPIRED');
  }

  // 3. Update → ACTIVE (sẽ kết hợp Phase 5 để auto-join channel)
  return activateMember(workspaceId, userId, invite.invitedById!, 'USER');
}
```

### 2.4 API 2.3: Reject Invitation

```typescript
// POST /api/workspaces/:workspaceId/invitations/reject
async function rejectInvitation(workspaceId, userId) {
  const invite = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } }
  });

  if (!invite) throw new AppError(404, 'INVITATION_NOT_FOUND');
  if (invite.status !== 'PENDING_INVITE') {
    throw new AppError(409, 'INVITATION_NOT_PENDING');
  }

  return prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId } },
    data: {
      status: 'REJECTED',
      rejectedAt: new Date(),
      approvedById: userId,        // Chính user reject
      approvedByType: 'USER',
    }
  });
}
```

---

## Phase 3: User Xin Vào Workspace (Request Flow)

> **Mục tiêu:** User tự gửi yêu cầu xin vào workspace

### 3.1 API cần triển khai

| # | Method | Endpoint | Mô tả |
|---|--------|----------|-------|
| 3.1 | `POST` | `/api/workspaces/:workspaceId/join-requests` | User gửi yêu cầu xin vào |

### 3.2 Schema Input

```typescript
export const createJoinRequestSchema = z.object({
  message: z.string().max(500).optional(),
});
```

### 3.3 Service Logic

```typescript
async function createJoinRequest(workspaceId, userId, dto) {
  // 1. Workspace phải tồn tại
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new AppError(404, 'WORKSPACE_NOT_FOUND');

  // 2. User chưa là member
  const existing = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } }
  });
  if (existing?.status === 'ACTIVE') {
    throw new AppError(409, 'ALREADY_MEMBER');
  }
  if (existing?.status === 'PENDING_REQUEST') {
    throw new AppError(409, 'REQUEST_ALREADY_PENDING');
  }

  // 3. Upsert WorkspaceMember
  return prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    create: {
      workspaceId,
      userId,
      role: 'MEMBER',
      status: 'PENDING_REQUEST',
      requestedById: userId,
      invitedAt: new Date(),
      expiresAt: addDays(new Date(), 7),
      inviteMessage: dto.message,
    },
    update: {
      status: 'PENDING_REQUEST',
      requestedById: userId,
      invitedAt: new Date(),
      expiresAt: addDays(new Date(), 7),
      inviteMessage: dto.message,
      acceptedAt: null,
      rejectedAt: null,
      approvedById: null,
    }
  });
}
```

---

## Phase 4: Admin Duyệt Request

> **Mục tiêu:** Admin xem và duyệt/từ chối các yêu cầu xin vào

### 4.1 API cần triển khai

| # | Method | Endpoint | Mô tả |
|---|--------|----------|-------|
| 4.1 | `GET` | `/api/workspaces/:workspaceId/join-requests` | Admin xem danh sách pending requests |
| 4.2 | `POST` | `/api/workspaces/:workspaceId/join-requests/:userId/approve` | Admin duyệt 1 request |
| 4.3 | `POST` | `/api/workspaces/:workspaceId/join-requests/:userId/reject` | Admin từ chối 1 request |

### 4.2 API 4.1: List Pending Requests

```typescript
// GET /api/workspaces/:workspaceId/join-requests
async function listPendingRequests(workspaceId, adminId) {
  await validateAdminPermission(workspaceId, adminId);

  return prisma.workspaceMember.findMany({
    where: {
      workspaceId,
      status: 'PENDING_REQUEST',
      expiresAt: { gt: new Date() }
    },
    include: {
      user: {
        select: {
          id: true,
          displayName: true,
          username: true,
          avatar: true,
          bio: true,
        }
      }
    },
    orderBy: { invitedAt: 'asc' } // FIFO
  });
}
```

### 4.3 API 4.2: Approve Request

```typescript
// POST /api/workspaces/:workspaceId/join-requests/:userId/approve
async function approveRequest(workspaceId, adminId, targetUserId) {
  await validateAdminPermission(workspaceId, adminId);

  const request = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } }
  });

  if (!request || request.status !== 'PENDING_REQUEST') {
    throw new AppError(409, 'REQUEST_NOT_PENDING');
  }
  if (request.expiresAt && request.expiresAt < new Date()) {
    throw new AppError(410, 'REQUEST_EXPIRED');
  }

  // Activate (Phase 5 kết hợp)
  return activateMember(workspaceId, targetUserId, adminId, 'ADMIN');
}
```

### 4.4 API 4.3: Reject Request

```typescript
// POST /api/workspaces/:workspaceId/join-requests/:userId/reject
async function rejectRequest(workspaceId, adminId, targetUserId) {
  await validateAdminPermission(workspaceId, adminId);

  const request = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } }
  });

  if (!request || request.status !== 'PENDING_REQUEST') {
    throw new AppError(409, 'REQUEST_NOT_PENDING');
  }

  return prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    data: {
      status: 'REJECTED',
      rejectedAt: new Date(),
      approvedById: adminId,
      approvedByType: 'ADMIN',
    }
  });
}
```

---

## Phase 5: Auto-Join Channel Default

> **Mục tiêu:** Khi member ACTIVE, tự động join các channel default public

### 5.1 Hàm dùng chung

```typescript
// src/services/workspaceMember.services.ts

async function activateMember(
  workspaceId: bigint,
  userId: bigint,
  approvedById: bigint,
  approvedByType: 'ADMIN' | 'USER'
) {
  const now = new Date();

  // 1. Update workspace_members → ACTIVE
  const member = await prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId } },
    data: {
      status: 'ACTIVE',
      acceptedAt: now,
      approvedById,
      approvedByType,
      joinedAt: now,
    }
  });

  // 2. Auto-join channel default (public + isDefault=true)
  const defaultChannels = await prisma.channel.findMany({
    where: {
      workspaceId,
      isPrivate: false,
      isDefault: true,
    },
    select: { id: true },
  });

  if (defaultChannels.length > 0) {
    await prisma.channelMember.createMany({
      data: defaultChannels.map(ch => ({
        channelId: ch.id,
        userId,
        role: 'MEMBER',
        joinedAt: now,
      })),
      skipDuplicates: true,
    });
  }

  return member;
}
```

### 5.2 Hook vào các API

| API | Hook vào `activateMember(...)` |
|-----|-------------------------------|
| Accept Invitation (2.2) | `activateMember(workspaceId, userId, invite.invitedById, 'USER')` |
| Approve Request (4.2) | `activateMember(workspaceId, userId, adminId, 'ADMIN')` |

---

## Phase 6: Quản Lý Pending (Cancel & Expire)

> **Mục tiêu:** Cho phép hủy pending + xử lý expire (tự động)

### 6.1 API cần triển khai

| # | Method | Endpoint | Mô tả |
|---|--------|----------|-------|
| 6.1 | `DELETE` | `/api/workspaces/:workspaceId/invitations/:userId` | Admin hủy lời mời đã gửi |
| 6.2 | `DELETE` | `/api/workspaces/:workspaceId/join-requests` | User rút yêu cầu đã gửi |

### 6.2 API 6.1: Cancel Invitation (Admin)

```typescript
// DELETE /api/workspaces/:workspaceId/invitations/:userId
async function cancelInvitation(workspaceId, adminId, targetUserId) {
  await validateAdminPermission(workspaceId, adminId);

  const invite = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } }
  });

  if (!invite || invite.status !== 'PENDING_INVITE') {
    throw new AppError(409, 'INVITATION_NOT_PENDING');
  }

  return prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    data: {
      status: 'CANCELLED',
      approvedById: adminId,
      approvedByType: 'ADMIN',
    }
  });
}
```

### 6.3 API 6.2: Withdraw Request (User)

```typescript
// DELETE /api/workspaces/:workspaceId/join-requests
async function withdrawRequest(workspaceId, userId) {
  const request = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } }
  });

  if (!request || request.status !== 'PENDING_REQUEST') {
    throw new AppError(409, 'REQUEST_NOT_PENDING');
  }

  return prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId } },
    data: {
      status: 'CANCELLED',
      approvedById: userId,
      approvedByType: 'USER',
    }
  });
}
```

### 6.4 Xử Lý Expire (Background Job)

```typescript
// Cron job chạy mỗi giờ
async function expireOldInvitations() {
  const now = new Date();

  // Lấy tất cả pending đã hết hạn
  await prisma.workspaceMember.updateMany({
    where: {
      status: { in: ['PENDING_INVITE', 'PENDING_REQUEST'] },
      expiresAt: { lt: now }
    },
    data: {
      // Không cần status riêng, chỉ filter expiresAt
      // Hoặc có thể set thêm flag nếu cần report
    }
  });
}
```

**Lưu ý:** Theo schema hiện tại, KHÔNG cần status `EXPIRED`. Hết hạn = bị filter ra khỏi query.

---

## Phase 7: Member Management (Active & Left)

> **Mục tiêu:** Quản lý member ACTIVE (kick, leave, change role)

### 7.1 API cần triển khai

| # | Method | Endpoint | Mô tả |
|---|--------|----------|-------|
| 7.1 | `GET` | `/api/workspaces/:workspaceId/members` | List tất cả members (active) |
| 7.2 | `GET` | `/api/workspaces/:workspaceId/members/:userId` | Chi tiết 1 member |
| 7.3 | `PATCH` | `/api/workspaces/:workspaceId/members/:userId/role` | Admin đổi role (MEMBER ↔ ADMIN) |
| 7.4 | `DELETE` | `/api/workspaces/:workspaceId/members/:userId` | Admin kick member |
| 7.5 | `POST` | `/api/workspaces/:workspaceId/leave` | Member tự rời workspace |

### 7.2 API 7.1: List Members

```typescript
// GET /api/workspaces/:workspaceId/members?status=ACTIVE&search=...
async function listMembers(workspaceId, query) {
  return prisma.workspaceMember.findMany({
    where: {
      workspaceId,
      ...(query.status && { status: query.status }),
      ...(query.search && {
        user: {
          OR: [
            { displayName: { contains: query.search, mode: 'insensitive' } },
            { username: { contains: query.search, mode: 'insensitive' } },
            { email: { contains: query.search, mode: 'insensitive' } }
          ]
        }
      })
    },
    include: {
      user: {
        select: {
          id: true,
          displayName: true,
          username: true,
          email: true,
          avatar: true,
          status: true
        }
      }
    },
    orderBy: [
      { role: 'asc' },  // OWNER > ADMIN > MEMBER
      { joinedAt: 'asc' }
    ]
  });
}
```

### 7.3 API 7.4: Kick Member

```typescript
// DELETE /api/workspaces/:workspaceId/members/:userId
async function kickMember(workspaceId, adminId, targetUserId) {
  await validateAdminPermission(workspaceId, adminId);

  // Không thể kick owner
  const target = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } }
  });
  if (!target || target.status !== 'ACTIVE') {
    throw new AppError(409, 'MEMBER_NOT_ACTIVE');
  }
  if (target.role === 'OWNER') {
    throw new AppError(403, 'CANNOT_KICK_OWNER');
  }

  // Set status = LEFT, không xóa row (giữ audit)
  return prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    data: { status: 'LEFT' }
  });
}
```

### 7.4 API 7.5: Leave Workspace

```typescript
// POST /api/workspaces/:workspaceId/leave
async function leaveWorkspace(workspaceId, userId) {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } }
  });

  if (!member || member.status !== 'ACTIVE') {
    throw new AppError(409, 'NOT_ACTIVE_MEMBER');
  }
  if (member.role === 'OWNER') {
    throw new AppError(403, 'OWNER_CANNOT_LEAVE');
  }

  // Set status = LEFT
  return prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId } },
    data: { status: 'LEFT' }
  });
}
```

---

## Tổng Hợp API

### Tất cả 14 API cần triển khai

| # | Phase | Method | Endpoint | Mô tả |
|---|-------|--------|----------|-------|
| 1 | P1 | POST | `/api/workspaces/:workspaceId/invitations` | Admin mời user |
| 2 | P2 | GET | `/api/users/me/workspace-invitations` | User xem invites |
| 3 | P2 | POST | `/api/workspaces/:workspaceId/invitations/accept` | User accept |
| 4 | P2 | POST | `/api/workspaces/:workspaceId/invitations/reject` | User reject |
| 5 | P3 | POST | `/api/workspaces/:workspaceId/join-requests` | User xin vào |
| 6 | P4 | GET | `/api/workspaces/:workspaceId/join-requests` | Admin xem requests |
| 7 | P4 | POST | `/api/workspaces/:workspaceId/join-requests/:userId/approve` | Admin duyệt |
| 8 | P4 | POST | `/api/workspaces/:workspaceId/join-requests/:userId/reject` | Admin từ chối |
| 9 | P6 | DELETE | `/api/workspaces/:workspaceId/invitations/:userId` | Admin hủy invite |
| 10 | P6 | DELETE | `/api/workspaces/:workspaceId/join-requests` | User rút request |
| 11 | P7 | GET | `/api/workspaces/:workspaceId/members` | List members |
| 12 | P7 | GET | `/api/workspaces/:workspaceId/members/:userId` | Chi tiết member |
| 13 | P7 | PATCH | `/api/workspaces/:workspaceId/members/:userId/role` | Đổi role |
| 14 | P7 | DELETE | `/api/workspaces/:workspaceId/members/:userId` | Admin kick member |
| 15 | P7 | POST | `/api/workspaces/:workspaceId/leave` | Member tự rời |

---

## Lộ Trình Triển Khai Gợi Ý

```
Week 1: Phase 0 + Phase 1 + Phase 2  (4 API)
        ├── Setup base utilities
        ├── Schema validation
        ├── Admin invite user
        └── User accept/reject

Week 2: Phase 3 + Phase 4 + Phase 5  (4 API + shared helper)
        ├── User request to join
        ├── Admin approve/reject
        └── Auto-join channel (SHARED)

Week 3: Phase 6 + Phase 7            (5 API)
        ├── Cancel/withdraw
        ├── Member management
        └── Cron job expire

Total: 14+ API trong ~3 tuần
```

---

## Checklist Trước Khi Bắt Đầu

- [x] Schema `WorkspaceMemberStatus` (6 trạng thái)
- [x] Schema `ApproverType` (ADMIN/USER)
- [x] Field `invitedById`, `requestedById`, `approvedById`, `approvedByType`
- [x] Field `invitedAt`, `acceptedAt`, `rejectedAt`, `expiresAt`
- [x] Field `inviteMessage`
- [x] Relations trên `User` (Inviter, Requester, Approver)
- [x] Migration đã chạy trên DB
- [x] Prisma Client đã generate
- [ ] Constants file tạo xong
- [ ] Helper `addDays()`, `validateAdminPermission()` tạo xong
