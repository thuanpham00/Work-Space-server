## Plan: API lấy thành viên workspace + lời mời / yêu cầu tham gia

### Tổng quan

UI "Quản lý thành viên workspace" có 3 tab:
- **Mọi người** — thành viên `ACTIVE`
- **Lời mời đã gửi** — `PENDING_INVITE`
- **Yêu cầu tham gia** — `PENDING_REQUEST`

Vì UI có 3 tab nhưng người dùng đã chốt **gộp 2 API**:
1. `GET /api/workspaces/:workspaceId/members` — tab "Mọi người"
2. `GET /api/workspaces/:workspaceId/requests` — gộp "Lời mời đã gửi" + "Yêu cầu tham gia", phân biệt bằng query `type=invite|join|all`

### Quyết định đã chốt với user

| Câu hỏi | Quyết định |
| --- | --- |
| Số lượng API read | **2 API** (`/members` + `/requests` gộp) |
| API write (mời, accept, reject, role change…) | **Chưa làm** (làm sau) |
| Search | `username` + `displayName` + `fullName`, case-insensitive contains |
| Pagination | `page` (default 1) + `limit` (default 20, max 100) |
| Phân quyền `/requests` | **Chỉ OWNER/ADMIN** (member thường → 403) |
| Phân quyền `/members` | Bất kỳ thành viên ACTIVE nào trong workspace |

### Thay đổi

#### 1. `server/src/models/schemas/workspace.schema.ts` (tạo mới)

```ts
import { z } from 'zod'

const paginationShape = {
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
}

export const getWorkspaceMembersSchema = z.object(paginationShape)

export const getWorkspaceRequestsSchema = z.object({
  ...paginationShape,
  type: z.enum(['invite', 'join', 'all']).default('all')
})
```

Đặt `paginationShape` riêng để 2 schema cùng dùng chung logic phân trang.

#### 2. `server/src/models/responses/workspace.response.ts` — thêm 2 interface

```ts
export interface WorkspaceMemberItem {
  id: string
  username: string
  displayName: string
  avatar: string | null
  fullName: string | null
  status: UserStatus
  role: WorkspaceMemberRole
  joinedAt: string | null
}

export interface WorkspaceRequestItem {
  userId: string
  username: string
  displayName: string
  avatar: string | null
  fullName: string | null
  status: UserStatus
  role: WorkspaceMemberRole
  type: 'invite' | 'join'
  invitedById: string | null
  invitedByName: string | null
  requestedById: string | null
  invitedAt: string | null
  joinedAt: null
}
```

`UserStatus` đã có sẵn trong `~/constants/enum`, import vào để giữ typing chuẩn.

#### 3. `server/src/services/workspace.services.ts` — thêm 2 method

```ts
async getWorkspaceMembers(workspaceId: bigint, search: string, page: number, limit: number) {
  const keyword = search.trim()
  const where: any = {
    workspaceId,
    status: WorkspaceMemberStatus.ACTIVE
  }
  if (keyword) {
    where.user = {
      OR: [
        { username: { contains: keyword, mode: 'insensitive' } },
        { displayName: { contains: keyword, mode: 'insensitive' } },
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
            displayName: true,
            avatar: true,
            fullName: true,
            status: true
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
      displayName: m.user.displayName,
      avatar: m.user.avatar,
      fullName: m.user.fullName,
      status: m.user.status,
      role: m.role,
      joinedAt: m.joinedAt?.toISOString() ?? null
    })),
    total,
    page,
    limit
  }
}

async getWorkspaceRequests(
  workspaceId: bigint,
  currentUserId: bigint,
  type: 'invite' | 'join' | 'all',
  search: string,
  page: number,
  limit: number
) {
  // 1. Phân quyền: chỉ OWNER / ADMIN ACTIVE
  const me = await databaseServices.prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: currentUserId } }
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

  // 2. Build filter status theo type
  const statusFilter =
    type === 'invite'
      ? WorkspaceMemberStatus.PENDING_INVITE
      : type === 'join'
        ? WorkspaceMemberStatus.PENDING_REQUEST
        : { in: [WorkspaceMemberStatus.PENDING_INVITE, WorkspaceMemberStatus.PENDING_REQUEST] }

  const keyword = search.trim()
  const where: any = { workspaceId, status: statusFilter }
  if (keyword) {
    where.user = {
      OR: [
        { username: { contains: keyword, mode: 'insensitive' } },
        { displayName: { contains: keyword, mode: 'insensitive' } },
        { fullName: { contains: keyword, mode: 'insensitive' } }
      ]
    }
  }

  // 3. Query song song
  const [requests, total, inviteCount, joinCount] = await Promise.all([
    databaseServices.prisma.workspaceMember.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true,
            fullName: true,
            status: true
          }
        }
      },
      orderBy: { invitedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    }),
    databaseServices.prisma.workspaceMember.count({ where }),
    databaseServices.prisma.workspaceMember.count({
      where: { workspaceId, status: WorkspaceMemberStatus.PENDING_INVITE }
    }),
    databaseServices.prisma.workspaceMember.count({
      where: { workspaceId, status: WorkspaceMemberStatus.PENDING_REQUEST }
    })
  ])

  // 4. Lấy thông tin inviter (dùng cho invitedByName)
  const inviterIds = [
    ...new Set(requests.map((r) => r.invitedById).filter((id): id is bigint => id !== null))
  ]
  const inviters = inviterIds.length
    ? await databaseServices.prisma.user.findMany({
        where: { id: { in: inviterIds } },
        select: { id: true, displayName: true, username: true }
      })
    : []
  const inviterMap = new Map(inviters.map((u) => [u.id.toString(), u]))

  return {
    requests: requests.map((r) => {
      const inviter = r.invitedById ? inviterMap.get(r.invitedById.toString()) : null
      return {
        userId: r.user.id.toString(),
        username: r.user.username,
        displayName: r.user.displayName,
        avatar: r.user.avatar,
        fullName: r.user.fullName,
        status: r.user.status,
        role: r.role,
        type: r.status === WorkspaceMemberStatus.PENDING_INVITE ? 'invite' : 'join',
        invitedById: r.invitedById?.toString() ?? null,
        invitedByName: inviter?.displayName ?? inviter?.username ?? null,
        requestedById: r.requestedById?.toString() ?? null,
        invitedAt: r.invitedAt?.toISOString() ?? null,
        joinedAt: null
      }
    }),
    total,
    inviteCount,
    joinCount,
    page,
    limit
  }
}
```

Cả 2 method dùng `Promise.all` để chạy song song — khớp pattern của `getAllChannelsFriends` trong `friend.services.ts`.

`WorkspaceMemberRole` đã có sẵn trong `~/constants/enum.ts` — chỉ cần import thêm.

#### 4. `server/src/controllers/workspace.controller.ts` — thêm 2 controller

```ts
export const getWorkspaceMembersController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId } = req.params
  const { user_id } = req.decode_authorization as TokenPayload
  const { search = '', page = '1', limit = '20' } = req.query as {
    search?: string
    page?: string
    limit?: string
  }

  const data = await workspaceServices.getWorkspaceMembers(
    BigInt(workspaceId as string),
    search,
    Number(page) || 1,
    Number(limit) || 20
  )

  const response: ApiResponse<typeof data> = {
    message: 'Lấy danh sách thành viên workspace thành công',
    data
  }

  res.json(response)
}

export const getWorkspaceRequestsController = async (req: AuthenticatedRequest, res: Response) => {
  const { workspaceId } = req.params
  const { user_id } = req.decode_authorization as TokenPayload
  const {
    type = 'all',
    search = '',
    page = '1',
    limit = '20'
  } = req.query as {
    type?: 'invite' | 'join' | 'all'
    search?: string
    page?: string
    limit?: string
  }

  const data = await workspaceServices.getWorkspaceRequests(
    BigInt(workspaceId as string),
    BigInt(user_id),
    type,
    search,
    Number(page) || 1,
    Number(limit) || 20
  )

  const response: ApiResponse<typeof data> = {
    message: 'Lấy danh sách lời mời và yêu cầu tham gia thành công',
    data
  }

  res.json(response)
}
```

Lưu ý: `ApiResponse<typeof data>` để TS tự infer type từ service — tránh phải khai báo interface trùng.

#### 5. `server/src/routes/workspace.routes.ts` — đăng ký 2 route

```ts
import {
  cancelJoinRequestController,
  getWorkspaceDetailController,
  getWorkspaceMemberStatusController,
  getWorkspaceMembersController,
  getWorkspaceRequestsController,
  getWorkspaceUserController,
  requestInviteToWorkspaceController
} from '~/controllers/workspace.controller'
import { getWorkspaceMembersSchema, getWorkspaceRequestsSchema } from '~/models/schemas/workspace.schema'

router.get(
  '/:workspaceId/members',
  accessTokenValidator,
  validateQuery(getWorkspaceMembersSchema),
  asyncHandler(getWorkspaceMembersController)
)

router.get(
  '/:workspaceId/requests',
  accessTokenValidator,
  validateQuery(getWorkspaceRequestsSchema),
  asyncHandler(getWorkspaceRequestsController)
)
```

Đặt ngay dưới route `/:workspaceId/status` để nhóm các route theo `:workspaceId` lại với nhau.

### Đường dẫn API

```
GET /api/workspaces/:workspaceId/members
GET /api/workspaces/:workspaceId/requests?type=invite|join|all
Header: Authorization: Bearer <access_token>
```

### Response mẫu

#### `GET /api/workspaces/:workspaceId/members`

```json
{
  "message": "Lấy danh sách thành viên workspace thành công",
  "data": {
    "members": [
      {
        "id": "1734567890",
        "username": "cuongvd",
        "displayName": "Văn Đức Cường",
        "avatar": "https://...",
        "fullName": "Nguyễn Văn A",
        "status": "ONLINE",
        "role": "OWNER",
        "joinedAt": "2026-09-12T03:00:00.000Z"
      }
    ],
    "total": 25,
    "page": 1,
    "limit": 20
  }
}
```

#### `GET /api/workspaces/:workspaceId/requests?type=all`

```json
{
  "message": "Lấy danh sách lời mời và yêu cầu tham gia thành công",
  "data": {
    "requests": [
      {
        "userId": "9876543210",
        "username": "userB",
        "displayName": "User B",
        "avatar": null,
        "fullName": "Trần Thị B",
        "status": "ONLINE",
        "role": "MEMBER",
        "type": "invite",
        "invitedById": "1734567890",
        "invitedByName": "Văn Đức Cường",
        "requestedById": null,
        "invitedAt": "2026-09-15T08:30:00.000Z",
        "joinedAt": null
      },
      {
        "userId": "1112223334",
        "username": "userC",
        "displayName": "User C",
        "avatar": null,
        "fullName": null,
        "status": "OFFLINE",
        "role": "MEMBER",
        "type": "join",
        "invitedById": null,
        "invitedByName": null,
        "requestedById": "1112223334",
        "invitedAt": null,
        "joinedAt": null
      }
    ],
    "total": 5,
    "inviteCount": 2,
    "joinCount": 3,
    "page": 1,
    "limit": 20
  }
}
```

### Lưu ý kỹ thuật

- **Pagination schema**: dùng `z.coerce.number()` thay vì `z.string().default()` của `queryBase` hiện có — vì friend schema cũ hơi cũ, schema mới cần chuẩn số ngay từ đầu để service nhận `number` thay vì `string`.
- **Quyền `/requests`**: kiểm tra trong service (throw `ErrorWithStatus` 403), không làm middleware riêng — vì pattern này giống `getWorkspaceMemberStatusController` hiện có.
- **`invitedByName`**: chỉ query 1 lần cho cả page (không N+1), dùng `Map` lookup.
- **`role` field**: lấy trực tiếp từ `workspaceMember.role` (đã có sẵn trong schema) — không cần join user.
- **`invitedAt` vs `joinedAt`**: member PENDING thì `joinedAt = null`, dùng `invitedAt` cho invite và fallback `joinedAt` cho join-request nếu cần (hiện tại join-request chỉ có `requestedById`, không có timestamp riêng).

### Kiểm tra sau khi sửa

- `npx tsc --noEmit` — chỉ kỳ vọng thấy các lỗi có sẵn (không liên quan file `workspace.*`).
- Test thủ công: gọi API với user là owner/admin → 200; với user là member thường → 403; với user không thuộc workspace → 403.

### File sẽ đụng đến

- `server/src/models/schemas/workspace.schema.ts` — **tạo mới**
- `server/src/models/responses/workspace.response.ts` — thêm 2 interface
- `server/src/services/workspace.services.ts` — thêm 2 method (`getWorkspaceMembers`, `getWorkspaceRequests`)
- `server/src/controllers/workspace.controller.ts` — thêm 2 controller
- `server/src/routes/workspace.routes.ts` — đăng ký 2 route mới
