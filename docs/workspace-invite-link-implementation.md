# Kế hoạch triển khai — Workspace Invite Link

> Tài liệu này track tiến độ triển khai tính năng invite link cho workspace.
> Spec API xem tại: [`./invite-link-api.md`](./invite-link-api.md)

---

## 🎯 Tổng quan

**Mục tiêu:** Cho phép workspace owner/admin mời thành viên qua link.

**Quy tắc nghiệp vụ:**
- Mỗi workspace tại **1 thời điểm chỉ có tối đa 1 link ACTIVE**
- Khi tạo workspace mới → tự động tạo 1 invite link ở trạng thái `REVOKED` (an toàn mặc định)
- Tạo link mới = revoke link cũ (atomic transaction)
- Revoke link = set `status = REVOKED`, không xóa row (giữ audit trail)

---

## 📊 Phase tổng quan

| Phase | Nội dung | Trạng thái |
|---|---|---|
| **Phase 1** | Schema: bảng `WorkspaceInvite` + enum + partial unique index | ⏳ Chưa làm |
| **Phase 2** | Auto-create link REVOKED khi tạo workspace | ⏳ Chưa làm |
| **Phase 3** | 3 API endpoint (get active, create, revoke) | ⏳ Chưa làm |
| **Phase 4** | Routes + middleware + response model | ⏳ Chưa làm |
| **Phase 5** | Test thủ công (Postman/curl) | ⏳ Chưa làm |

---

## 🗂️ Phase 1: Schema

### 1.1. Thêm enum `WorkspaceInviteStatus`

```prisma
enum WorkspaceInviteStatus {
  ACTIVE   @map("active")
  REVOKED  @map("revoked")

  @@map("workspace_invite_status")
}
```

### 1.2. Thêm model `WorkspaceInvite`

```prisma
model WorkspaceInvite {
  id          BigInt                @id @default(autoincrement())
  code        String                @unique @db.VarChar(32)
  workspaceId BigInt                @map("workspace_id")
  role        WorkspaceMemberRole   @default(MEMBER)
  status      WorkspaceInviteStatus @default(REVOKED)
  expiresAt   DateTime?             @map("expires_at")
  createdById BigInt                @map("created_by_id")
  createdAt   DateTime              @default(now()) @map("created_at")
  updatedAt   DateTime              @updatedAt @map("updated_at")
  revokedAt   DateTime?             @map("revoked_at")
  revokedById BigInt?               @map("revoked_by_id")

  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  createdBy   User      @relation("WorkspaceInviteCreator", fields: [createdById], references: [id], onDelete: SetNull)
  revokedBy   User?     @relation("WorkspaceInviteRevoker", fields: [revokedById], references: [id], onDelete: SetNull)

  @@index([workspaceId, status])
  @@index([expiresAt])
  @@map("workspace_invites")
}
```

### 1.3. Thêm relation vào model `User`

```prisma
// Trong model User, thêm:
workspaceInvitesCreated WorkspaceInvite[] @relation("WorkspaceInviteCreator")
workspaceInvitesRevoked WorkspaceInvite[] @relation("WorkspaceInviteRevoker")
```

### 1.4. Thêm relation vào model `Workspace`

```prisma
// Trong model Workspace, thêm:
invites WorkspaceInvite[]
```

### 1.5. Migration + Partial Unique Index (raw SQL)

```bash
npx prisma migrate dev --name add_workspace_invites
```

Sau đó sửa file migration vừa tạo, thêm vào cuối:

```sql
-- Partial unique index: 1 workspace chỉ có 1 link ACTIVE
CREATE UNIQUE INDEX workspace_invites_one_active 
ON workspace_invites (workspace_id) 
WHERE status = 'ACTIVE';

-- Index phụ cho query "link mới nhất ACTIVE của workspace"
CREATE INDEX workspace_invites_workspace_status_active 
ON workspace_invites (workspace_id, created_at DESC) 
WHERE status = 'ACTIVE';
```

### 1.6. Generate client + verify

```bash
npx prisma generate
npx prisma studio    # mở Prisma Studio, kiểm tra bảng + index
```

---

## 🏗️ Phase 2: Auto-create link khi tạo workspace

### 2.1. Helper `generateUniqueInviteCode`

**File:** `src/utils/utils.ts`

```typescript
import { customAlphabet } from 'nanoid'

// Bỏ các ký tự dễ nhầm: 0/O, 1/I/l
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz'
const generateInviteCode = customAlphabet(alphabet, 10)

export async function generateUniqueInviteCode(
  prisma: PrismaClient,
  maxRetries = 5
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    const code = generateInviteCode()
    const exists = await prisma.workspaceInvite.findUnique({ where: { code } })
    if (!exists) return code
  }
  throw new Error('Failed to generate unique invite code')
}
```

> **Lưu ý:** Nếu chưa có `nanoid`, cài: `npm i nanoid`. Hoặc dùng `crypto.randomBytes` từ Node.

### 2.2. Wrap `createWorkspace` trong transaction

**File:** `src/services/workspace.services.ts`

Trong method `createWorkspace`, wrap trong transaction và thêm bước tạo invite REVOKED:

```typescript
async createWorkspace(payload: { name: string; description?: string }, userId: bigint) {
  return await databaseServices.prisma.$transaction(async (tx) => {
    // 1. Tạo workspace + workspaceMember (owner)
    const workspace = await tx.workspace.create({
      data: {
        name: payload.name,
        description: payload.description,
        ownerId: userId,
        members: {
          create: {
            userId,
            role: WorkspaceMemberRole.OWNER,
            status: WorkspaceMemberStatus.ACTIVE,
            joinedAt: new Date(),
            acceptedAt: new Date(),
            approvedById: userId,
            approvedByType: ApproverType.USER
          }
        }
      }
    })

    // 2. Auto-create invite link REVOKED
    const code = await generateUniqueInviteCode(tx as PrismaClient)
    await tx.workspaceInvite.create({
      data: {
        code,
        workspaceId: workspace.id,
        role: WorkspaceMemberRole.MEMBER,
        status: WorkspaceInviteStatus.REVOKED,
        expiresAt: null,
        createdById: userId
      }
    })

    return workspace
  })
}
```

---

## 🔌 Phase 3: 3 API Endpoint

### 3a. API 1: GET link active hiện tại

**Route:** `GET /workspaces/:workspaceId/invite-link`

**Mục đích:** Modal "Mời thành viên" hiển thị link để user copy.

**Auth:** Workspace ACTIVE member.

**Response:**

```json
// Thành công - có link
{
  "message": "OK",
  "data": {
    "code": "aB3x9KxZ7m",
    "role": "MEMBER",
    "url": "http://localhost:5173/invite/aB3x9KxZ7m",
    "expiresAt": "2026-10-05T10:00:00.000Z",
    "createdAt": "2026-09-28T10:00:00.000Z"
  }
}

// Thành công - không có link ACTIVE
{
  "message": "Workspace chưa có link mời đang hoạt động",
  "data": null
}
```

**Service:** `workspace.services.ts`

```typescript
async getActiveInviteLink(workspaceId: bigint, userId: bigint) {
  // 1. Check ACTIVE member
  await this.checkActiveMembership(workspaceId, userId)

  // 2. Lấy link ACTIVE (partial unique index đảm bảo chỉ có 1)
  const invite = await databaseServices.prisma.workspaceInvite.findFirst({
    where: {
      workspaceId,
      status: WorkspaceInviteStatus.ACTIVE,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } }
      ]
    }
  })

  return invite
    ? {
        code: invite.code,
        role: invite.role,
        url: `${process.env.FRONTEND_URL}/invite/${invite.code}`,
        expiresAt: invite.expiresAt?.toISOString() ?? null,
        createdAt: invite.createdAt.toISOString()
      }
    : null
}
```

**Controller:** `workspace.controller.ts`

```typescript
async getActiveInviteLink(req: Request, res: Response) {
  const { workspaceId } = req.params
  const userId = req.user.id

  const data = await workspaceServices.getActiveInviteLink(
    BigInt(workspaceId),
    BigInt(userId)
  )

  return res.json({
    message: data
      ? 'OK'
      : 'Workspace chưa có link mời đang hoạt động',
    data
  })
}
```

---

### 3b. API 2: Tạo link mới (revoke link cũ)

**Route:** `POST /workspaces/:workspaceId/invite-link`

**Mục đích:** Workspace Settings → "Lời mời" → "Tạo lời mời mới".

**Auth:** Workspace ADMIN hoặc OWNER.

**Body:**

```typescript
{
  role?: "ADMIN" | "MEMBER",       // default "MEMBER"
  ttlSeconds?: number | null       // null = không hết hạn; undefined = mặc định 7 ngày
}
```

**Validation schema:** `src/models/schemas/workspace.schema.ts`

```typescript
import { z } from 'zod'

export const createInviteLinkSchema = z.object({
  body: z.object({
    role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
    ttlSeconds: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
  })
})

export type CreateInviteLinkBody = z.infer<typeof createInviteLinkSchema>['body']
```

**Service:**

```typescript
async createInviteLink(
  workspaceId: bigint,
  userId: bigint,
  role: WorkspaceMemberRole,
  ttlSeconds?: number | null
) {
  // 1. Check admin permission
  await this.checkAdminPermission(workspaceId, userId)

  // 2. Tính expiresAt
  let expiresAt: Date | null = null
  if (ttlSeconds !== undefined) {
    expiresAt = ttlSeconds === null ? null : new Date(Date.now() + ttlSeconds * 1000)
  } else {
    expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // default 7 ngày
  }

  // 3. Transaction: revoke link cũ + tạo link mới
  return await databaseServices.prisma.$transaction(async (tx) => {
    // Revoke link ACTIVE cũ (nếu có)
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

    // Generate unique code
    const code = await generateUniqueInviteCode(tx as PrismaClient)

    // Tạo link ACTIVE mới
    return await tx.workspaceInvite.create({
      data: {
        code,
        workspaceId,
        role,
        status: WorkspaceInviteStatus.ACTIVE,
        expiresAt,
        createdById: userId
      }
    })
  })
}
```

**Controller:**

```typescript
async createInviteLink(req: Request, res: Response) {
  const { workspaceId } = req.params
  const userId = req.user.id
  const { role, ttlSeconds } = req.body as CreateInviteLinkBody

  const invite = await workspaceServices.createInviteLink(
    BigInt(workspaceId),
    BigInt(userId),
    role ?? WorkspaceMemberRole.MEMBER,
    ttlSeconds
  )

  return res.json({
    message: 'Tạo link mời thành công',
    data: {
      code: invite.code,
      role: invite.role,
      url: `${process.env.FRONTEND_URL}/invite/${invite.code}`,
      expiresAt: invite.expiresAt?.toISOString() ?? null,
      createdAt: invite.createdAt.toISOString()
    }
  })
}
```

---

### 3c. API 3: Revoke link

**Route:** `PATCH /workspaces/:workspaceId/invite-link/:code/revoke`

**Mục đích:** Workspace Settings → "Lời mời" → "Thu hồi".

**Auth:** Workspace ADMIN hoặc OWNER.

**Response:**

```json
{
  "message": "Thu hồi link thành công",
  "data": {
    "code": "aB3x9KxZ7m",
    "status": "REVOKED",
    "revokedAt": "2026-09-28T10:30:00.000Z"
  }
}
```

**Service:**

```typescript
async revokeInviteLink(workspaceId: bigint, code: string, userId: bigint) {
  // 1. Check admin permission
  await this.checkAdminPermission(workspaceId, userId)

  // 2. Tìm invite
  const invite = await databaseServices.prisma.workspaceInvite.findUnique({
    where: { code }
  })

  if (!invite || invite.workspaceId !== workspaceId) {
    throw new ErrorWithStatus({
      message: 'Không tìm thấy link mời',
      status: httpStatus.NOT_FOUND
    })
  }

  if (invite.status === WorkspaceInviteStatus.REVOKED) {
    throw new ErrorWithStatus({
      message: 'Link đã được thu hồi trước đó',
      status: httpStatus.BAD_REQUEST
    })
  }

  // 3. Update status
  return await databaseServices.prisma.workspaceInvite.update({
    where: { code },
    data: {
      status: WorkspaceInviteStatus.REVOKED,
      revokedAt: new Date(),
      revokedById: userId
    }
  })
}
```

**Controller:**

```typescript
async revokeInviteLink(req: Request, res: Response) {
  const { workspaceId, code } = req.params
  const userId = req.user.id

  const invite = await workspaceServices.revokeInviteLink(
    BigInt(workspaceId),
    code,
    BigInt(userId)
  )

  return res.json({
    message: 'Thu hồi link thành công',
    data: {
      code: invite.code,
      status: invite.status,
      revokedAt: invite.revokedAt?.toISOString() ?? null
    }
  })
}
```

---

## 🚦 Phase 4: Routes + Middleware

**File:** `src/routes/workspace.routes.ts`

```typescript
import { createInviteLinkSchema } from '~/models/schemas/workspace.schema'
import { validate } from '~/middlewares/validate.middleware'

workspaceRouter.get(
  '/:workspaceId/invite-link',
  authenticate,
  workspaceController.getActiveInviteLink
)

workspaceRouter.post(
  '/:workspaceId/invite-link',
  authenticate,
  validate(createInviteLinkSchema),
  workspaceController.createInviteLink
)

workspaceRouter.patch(
  '/:workspaceId/invite-link/:code/revoke',
  authenticate,
  workspaceController.revokeInviteLink
)
```

**File:** `src/models/responses/workspace.response.ts`

Thêm các type:

```typescript
export interface InviteLinkData {
  code: string
  role: WorkspaceMemberRole
  url: string
  expiresAt: string | null
  createdAt: string
}

export interface RevokeInviteLinkResponse {
  code: string
  status: WorkspaceInviteStatus
  revokedAt: string | null
}
```

---

## 🧪 Phase 5: Test thủ công

### Case 1: Auto-create link khi tạo workspace

```bash
POST /workspaces { name: "Test Workspace" }
```

**Verify DB:**
```sql
SELECT * FROM workspace_invites WHERE workspace_id = X;
-- Expect: 1 row, status = 'revoked'
```

---

### Case 2: Tạo link active

```bash
POST /workspaces/:id/invite-link
Body: { "role": "MEMBER", "ttlSeconds": 604800 }
```

**Expect:** 200 + trả về URL

---

### Case 3: Lấy link active

```bash
GET /workspaces/:id/invite-link
```

**Expect:** Trả về link vừa tạo

---

### Case 4: Tạo link mới → link cũ tự động revoke

```bash
POST /workspaces/:id/invite-link
Body: { "role": "ADMIN", "ttlSeconds": null }
```

**Verify:**
- GET trả về link mới
- DB: link cũ có `status = 'revoked'`, `revoked_at` không null

---

### Case 5: Revoke link

```bash
PATCH /workspaces/:id/invite-link/:code/revoke
```

**Expect:** 200 + status = REVOKED

---

### Case 6: Sau revoke → modal thấy empty state

```bash
GET /workspaces/:id/invite-link
```

**Expect:** `data: null`

---

### Case 7: Edge case — 2 admin tạo link đồng thời

```bash
# Gửi 2 request song song
POST /workspaces/:id/invite-link   # request 1
POST /workspaces/:id/invite-link   # request 2
```

**Expect:**
- 1 request thành công
- 1 request fail với lỗi transaction conflict → FE retry

---

### Case 8: Kiểm tra phân quyền

```bash
# MEMBER (không phải admin) gọi API tạo/revoke link
POST /workspaces/:id/invite-link
PATCH /workspaces/:id/invite-link/:code/revoke
```

**Expect:** 403 Forbidden

---

### Case 9: Kiểm tra link hết hạn

```bash
# Tạo link TTL 5 giây, đợi 6 giây
POST /workspaces/:id/invite-link
Body: { "ttlSeconds": 5 }
sleep 6
GET /workspaces/:id/invite-link
```

**Expect:** `data: null` (link đã expire, không còn ACTIVE)

---

## 📋 Checklist tổng hợp

| # | Task | File | Trạng thái |
|---|---|---|---|
| 1.1 | Thêm enum `WorkspaceInviteStatus` | `schema.prisma` | ⏳ |
| 1.2 | Thêm model `WorkspaceInvite` | `schema.prisma` | ⏳ |
| 1.3 | Thêm relations `User` ↔ `WorkspaceInvite` | `schema.prisma` | ⏳ |
| 1.4 | Thêm relation `Workspace` ↔ `WorkspaceInvite` | `schema.prisma` | ⏳ |
| 1.5 | Migration + partial unique index (raw SQL) | `prisma/migrations/` | ⏳ |
| 1.6 | `prisma generate` + verify | Terminal | ⏳ |
| 2.1 | Helper `generateUniqueInviteCode` | `utils.ts` | ⏳ |
| 2.2 | Wrap `createWorkspace` + auto-create invite REVOKED | `workspace.services.ts` | ⏳ |
| 3a.1 | Service `getActiveInviteLink` | `workspace.services.ts` | ⏳ |
| 3a.2 | Controller `getActiveInviteLink` | `workspace.controller.ts` | ⏳ |
| 3b.1 | Validation schema `createInviteLinkSchema` | `workspace.schema.ts` | ⏳ |
| 3b.2 | Service `createInviteLink` | `workspace.services.ts` | ⏳ |
| 3b.3 | Controller `createInviteLink` | `workspace.controller.ts` | ⏳ |
| 3c.1 | Service `revokeInviteLink` | `workspace.services.ts` | ⏳ |
| 3c.2 | Controller `revokeInviteLink` | `workspace.controller.ts` | ⏳ |
| 4.1 | Thêm 3 route + middleware validate | `workspace.routes.ts` | ⏳ |
| 4.2 | Response types `InviteLinkData`, `RevokeInviteLinkResponse` | `workspace.response.ts` | ⏳ |
| 5.1 | Test 9 case trên | Postman/curl | ⏳ |

---

## 🔗 Liên kết

- [API spec chi tiết](./invite-link-api.md)
- [Prisma schema](../prisma/schema.prisma)
- [Workspace service](../src/services/workspace.services.ts)
- [Workspace controller](../src/controllers/workspace.controller.ts)
- [Workspace routes](../src/routes/workspace.routes.ts)

---

## 📝 Ghi chú khi triển khai

### Phụ thuộc cần cài thêm
- `nanoid` (nếu chưa có): `npm i nanoid`

### Biến môi trường
- `FRONTEND_URL`: URL frontend dùng để build link mời (vd: `http://localhost:5173`)

### Partial Unique Index — tại sao quan trọng
Postgres hỗ trợ partial unique index giúp đảm bảo **1 workspace chỉ có 1 link ACTIVE** ở tầng database. Nếu 2 transaction cùng insert ACTIVE → 1 sẽ fail với lỗi `P2002`.

### Order khi code
1. **Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5** (theo thứ tự)
2. Sau mỗi Phase, nên test migration / endpoint trước khi qua Phase tiếp theo.
3. Phase 5 nên test theo thứ tự Case 1 → 9.

---

**Cập nhật lần cuối:** $(date)
