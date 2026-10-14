# Channel Invite API Documentation

> Tài liệu cho Frontend — 2 endpoint Admin/Owner quản lý **lời mời cá nhân** vào channel (gửi invite / thu hồi invite; khác với invite link công khai).
>
> **Liên quan:** 2 endpoint user tự phản hồi invite (`accept` / `reject`) xem tại [docs/channel-invite-user-response.md](docs/channel-invite-user-response.md).

**Base URL:** `/api/channels`
**Auth:** Tất cả endpoint yêu cầu `Authorization: Bearer <access_token>`
**Content-Type:** `application/json`

---

## 1. Admin mời user vào channel

Mời trực tiếp một user (đã là workspace member) vào channel cụ thể. Tạo `channelMember` với status `PENDING_INVITE` — user phải accept/reject lời mời.

```
POST /api/channels/:channelId/invite
```

### Middleware chain (theo thứ tự)
1. `accessTokenValidator` — xác thực JWT
2. `validateParams(channelIdSchema)` — validate `channelId` trong URL
3. `validate(inviteUserBodySchema)` — validate body
4. `checkChannelExistAndUserIsMember` — channel tồn tại, caller đang là member
5. `channelAdminValidator()` — caller phải là `OWNER` hoặc `ADMIN` của channel
6. `inviteUserToChannelController` — xử lý

### Request

**Path params:**

| Field       | Type   | Required | Mô tả                       |
| ----------- | ------ | -------- | --------------------------- |
| `channelId` | string | ✅       | ID của channel (BigInt string) |

**Body:**

```json
{
  "userId": "1745263527180001"
}
```

| Field    | Type   | Required | Mô tả                                                       |
| -------- | ------ | -------- | ----------------------------------------------------------- |
| `userId` | string | ✅       | ID user được mời (BigInt string, phải là workspace member) |

### Response — `201 Created`

```json
{
  "message": "Mời user vào channel thành công",
  "data": {
    "channelId": "1745263527180002",
    "userId": "1745263527180001",
    "status": "PENDING_INVITE",
    "invitedById": "1745263527180000",
    "createdAt": "2026-10-10T10:30:00.000Z"
  }
}
```

| Field          | Type   | Mô tả                                              |
| -------------- | ------ | -------------------------------------------------- |
| `channelId`    | string | ID channel                                         |
| `userId`       | string | ID user được mời                                   |
| `status`       | string | Luôn là `PENDING_INVITE`                           |
| `invitedById`  | string | ID admin/owner đã gửi lời mời                      |
| `createdAt`    | string | ISO timestamp lúc tạo                              |

### Side effects
- Tạo/cập nhật row `channelMember` với `status = PENDING_INVITE`, `invitedById = caller`.
- Đồng bộ `workspaceMember` của user (xem `syncWorkspaceMember`).
- **KHÔNG emit socket** — frontend nên refetch danh sách requests qua `GET /api/channels/:channelId/requests` hoặc listen `channel_settings_updated`.

### Error responses

| Status | Message                                              | Nguyên nhân                                            |
| ------ | ---------------------------------------------------- | ------------------------------------------------------ |
| 400    | `ID channel của bạn không được để trống`             | Thiếu `channelId` trong URL                            |
| 400    | `ID user được mời không được để trống`               | Thiếu `userId` trong body                              |
| 400    | `Channel không tồn tại hoặc không thuộc workspace nào` | Channel DM hoặc không có workspace                   |
| 400    | `User đã là thành viên của channel này`               | User đã ACTIVE trong channel                           |
| 400    | `Đã có lời mời tham gia channel cho user này`        | Đã có invite PENDING_INVITE từ trước                  |
| 401    | `Unauthorized`                                       | Thiếu/sai access_token                                 |
| 403    | `Bạn không có quyền thực hiện hành động này`         | Caller không phải OWNER/ADMIN của channel              |
| 404    | `Channel không tồn tại`                              | Channel không tồn tại hoặc caller không phải member    |

### Example

```bash
curl -X POST https://api.example.com/api/channels/1745263527180002/invite \
  -H "Authorization: Bearer eyJhbGciOi..." \
  -H "Content-Type: application/json" \
  -d '{"userId":"1745263527180001"}'
```

---

## 2. Admin thu hồi lời mời đã gửi

Thu hồi lời mời `PENDING_INVITE` đã gửi trước đó. Set `channelMember.status = LEFT` (terminal state — không xóa row để audit).

```
DELETE /api/channels/:channelId/invites/:userId
```

### Middleware chain (theo thứ tự)
1. `accessTokenValidator` — xác thực JWT
2. `validateParams(channelIdAndUserIdParamSchema)` — validate cả 2 param
3. `checkChannelExistAndUserIsMember` — channel tồn tại, caller đang là member
4. `channelAdminValidator()` — caller phải là `OWNER` hoặc `ADMIN`
5. `revokeInviteController` — xử lý

### Request

**Path params:**

| Field       | Type   | Required | Mô tả                                |
| ----------- | ------ | -------- | ------------------------------------ |
| `channelId` | string | ✅       | ID của channel                       |
| `userId`    | string | ✅       | ID user **đã được mời** trước đó     |

**Body:** Không có.

### Response — `200 OK`

```json
{
  "message": "Thu hồi lời mời thành công",
  "data": {
    "channelId": "1745263527180002",
    "userId": "1745263527180001",
    "status": "LEFT",
    "revokedById": "1745263527180000"
  }
}
```

| Field         | Type   | Mô tả                                          |
| ------------- | ------ | ---------------------------------------------- |
| `channelId`   | string | ID channel                                     |
| `userId`      | string | ID user bị thu hồi lời mời                     |
| `status`      | string | Luôn là `LEFT`                                 |
| `revokedById` | string | ID admin/owner đã thu hồi                      |

### Side effects
- Update `channelMember.status` từ `PENDING_INVITE` → `LEFT`.
- Đồng bộ `workspaceMember` của user.
- **KHÔNG emit socket** — frontend nên refetch requests list.

### Error responses

| Status | Message                                              | Nguyên nhân                                            |
| ------ | ---------------------------------------------------- | ------------------------------------------------------ |
| 400    | `ID channel không được để trống`                     | Thiếu `channelId`                                      |
| 400    | `ID user không được để trống`                        | Thiếu `userId`                                         |
| 400    | `Channel không tồn tại hoặc không thuộc workspace nào` | Channel DM hoặc không có workspace                   |
| 400    | `Không có lời mời nào đang pending để thu hồi`       | User không tồn tại trong channel HOẶC status ≠ PENDING_INVITE |
| 401    | `Unauthorized`                                       | Thiếu/sai access_token                                 |
| 403    | `Bạn không có quyền thực hiện hành động này`         | Caller không phải OWNER/ADMIN                          |
| 404    | `Channel không tồn tại`                              | Channel không tồn tại hoặc caller không phải member    |

### Example

```bash
curl -X DELETE https://api.example.com/api/channels/1745263527180002/invites/1745263527180001 \
  -H "Authorization: Bearer eyJhbGciOi..."
```

---

## Luồng liên quan (Frontend nên biết)

### State machine của `channelMember.status`

```
            ┌──────────────┐
            │ PENDING_INVITE│ ←─── POST /:channelId/invite
            └──────┬───────┘
                   │
       ┌───────────┼───────────┐
       │           │           │
 (revoke/admin) (accept)  (reject/user)
       │           │           │
       ▼           ▼           ▼
    ┌──────┐  ┌────────┐   ┌──────┐
    │ LEFT │  │ ACTIVE │   │ LEFT │
    └──────┘  └────────┘   └──────┘
                       ↑
            (xem docs/channel-invite-user-response.md
             cho POST /:channelId/accept-invite
                  và POST /:channelId/reject-invite)
```

### API liên quan để fetch danh sách invites/joins

| Endpoint                                            | Mô tả                                                       |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `GET /api/channels/:channelId/requests`             | Lấy tất cả invites (PENDING_INVITE) + join requests (PENDING_REQUEST) |
| `POST /api/channels/:channelId/request-join`        | User tự gửi yêu cầu xin vào channel public                  |
| `DELETE /api/channels/:channelId/request-join`      | User tự hủy yêu cầu xin vào                                 |
| `POST /api/channels/:channelId/accept-invite`       | User tự chấp nhận lời mời — xem [docs/channel-invite-user-response.md](docs/channel-invite-user-response.md) |
| `POST /api/channels/:channelId/reject-invite`       | User tự từ chối lời mời — xem [docs/channel-invite-user-response.md](docs/channel-invite-user-response.md) |

### Lưu ý quan trọng cho Frontend

1. **Phân biệt 2 loại invite:**
   - **Invite cá nhân** (API này) — chỉ định 1 user qua `userId`.
   - **Invite link** — `POST /api/channels/:channelId/invite-link` tạo link công khai, nhiều người dùng.

2. **Phân biệt 2 actor cho invite cá nhân:**
   - **Admin gửi/thu hồi invite** (2 API trong file này) — yêu cầu OWNER/ADMIN channel.
   - **User phản hồi invite** (accept/reject) — xem [docs/channel-invite-user-response.md](docs/channel-invite-user-response.md), không cần quyền, userId lấy từ JWT.

3. **Không có socket event** cho cả 4 API → frontend phải refetch danh sách sau khi gọi thành công.

4. **`status` enum (6 giá trị):** `PENDING_INVITE | PENDING_REQUEST | ACTIVE | LEFT | CANCELED | BANNED` — dùng để filter UI. Xem bảng so sánh `LEFT` / `CANCELED` / `BANNED` tại [docs/channel-invite-user-response.md](docs/channel-invite-user-response.md).

5. **`workspaceMember.status` derive** từ tập `channelMember.status` của user trong workspace. Xem chi tiết tại `docs/channel-workspace-member-sync-flows.md`.

6. **Idempotency:** 4 API KHÔNG idempotent (mỗi lần gọi đều ghi lại `joinedAt`/`rejectedAt`). Frontend nên debounce button.

---

## TypeScript types (copy vào FE)

```typescript
// Enum cho channelMember.status (mirror từ backend)
export enum MemberStatus {
  PENDING_INVITE = 'PENDING_INVITE',
  PENDING_REQUEST = 'PENDING_REQUEST',
  ACTIVE = 'ACTIVE',
  LEFT = 'LEFT',
  CANCELED = 'CANCELED'
}

// Enum cho channelMember.role
export enum ChannelMemberRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER'
}

// Request body cho POST /:channelId/invite
export interface InviteUserToChannelRequest {
  userId: string
}

// Response data cho POST /:channelId/invite
export interface InviteUserToChannelResponse {
  channelId: string
  userId: string
  status: MemberStatus.PENDING_INVITE
  invitedById: string
  createdAt: string
}

// Response data cho DELETE /:channelId/invites/:userId
export interface RevokeInviteResponse {
  channelId: string
  userId: string
  status: MemberStatus.LEFT
  revokedById: string
}

// Generic API envelope
export interface ApiResponse<T> {
  message: string
  data?: T
  error?: string
}
```
