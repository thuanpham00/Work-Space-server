# Channel Invite — User Response API Documentation

> Tài liệu cho Frontend — 2 endpoint user tự phản hồi **lời mời cá nhân** vào channel (`accept` / `reject`). Đây là phần mở rộng của [docs/channel-invite-api.md](docs/channel-invite-api.md) (chứa 2 API admin gửi/thu hồi invite).
>
> **Quy tắc chung:** userId lấy từ JWT token, không nhận từ body/params. User tự thực hiện, không cần quyền admin/owner.

**Base URL:** `/api/channels`
**Auth:** Tất cả endpoint yêu cầu `Authorization: Bearer <access_token>`
**Content-Type:** `application/json`

Tham chiếu state machine & business rules: [docs/channel-workspace-member-sync-flows.md](docs/channel-workspace-member-sync-flows.md) — Flow #4 (accept) & Flow #5 (reject).

---

## 1. User chấp nhận lời mời vào channel

User tự chấp nhận lời mời đang ở trạng thái `PENDING_INVITE`. Update `channelMember.status` từ `PENDING_INVITE` → `ACTIVE`, đồng thời đồng bộ `workspaceMember` (Flow #4).

```
POST /api/channels/:channelId/accept-invite
```

### Middleware chain (theo thứ tự)
1. `accessTokenValidator` — xác thực JWT, lấy `userId` từ token
2. `validateParams(channelIdSchema)` — validate `channelId` trong URL
3. `checkChannelExistOnly` — channel tồn tại (chưa cần là member)
4. `acceptInviteController` — xử lý (service kiểm tra row `PENDING_INVITE` của caller)

**Lưu ý:** Method này user tự thực hiện, không cần quyền admin/owner. Server xác định user qua JWT, không nhận `userId` từ body/params.

### Request

**Path params:**

| Field       | Type   | Required | Mô tả                          |
| ----------- | ------ | -------- | ------------------------------ |
| `channelId` | string | ✅       | ID của channel (BigInt string) |

**Body:** Không có.

### Response — `200 OK`

```json
{
  "message": "Chấp nhận lời mời thành công",
  "data": {
    "channelId": "1745263527180002",
    "userId": "1745263527180001",
    "status": "ACTIVE",
    "acceptedAt": "2026-10-10T10:30:00.000Z"
  }
}
```

| Field        | Type   | Mô tả                                       |
| ------------ | ------ | ------------------------------------------- |
| `channelId`  | string | ID channel                                  |
| `userId`     | string | ID user đã accept (lấy từ JWT)             |
| `status`     | string | Luôn là `ACTIVE`                            |
| `acceptedAt` | string | ISO timestamp lúc accept (= `joinedAt` mới) |

### Side effects
- Update `channelMember.status` từ `PENDING_INVITE` → `ACTIVE`, `joinedAt = now`.
- Đồng bộ `workspaceMember` qua helper `syncWorkspaceMember`:
  - Nếu user chưa từng ACTIVE workspace → tạo mới `workspaceMember.status = ACTIVE`.
  - Nếu user đã ACTIVE workspace (qua channel khác) → giữ nguyên `ACTIVE`.
- **KHÔNG emit socket** — frontend nên refetch danh sách channels/members.

### Error responses

| Status | Message                                                  | Nguyên nhân                                                  |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------ |
| 400    | `ID channel của bạn không được để trống`                 | Thiếu `channelId` trong URL                                  |
| 400    | `Chỉ accept được lời mời đang ở trạng thái PENDING_INVITE` | User đã ACTIVE / LEFT / CANCELED rồi, không phải PENDING_INVITE |
| 401    | `Unauthorized`                                           | Thiếu/sai access_token                                       |
| 404    | `Channel không tồn tại`                                  | Channel không tồn tại                                       |
| 404    | `Channel không tồn tại hoặc không thuộc workspace nào`   | Channel DM hoặc không có workspace                          |
| 404    | `Bạn không có lời mời nào cho channel này`               | Caller chưa từng được mời vào channel này                    |

### Example

```bash
curl -X POST https://api.example.com/api/channels/1745263527180002/accept-invite \
  -H "Authorization: Bearer eyJhbGciOi..."
```

---

## 2. User từ chối lời mời vào channel

User tự từ chối lời mời đang ở trạng thái `PENDING_INVITE`. Update `channelMember.status` → `LEFT` (terminal state, giữ row để audit), đồng thời đồng bộ `workspaceMember` (Flow #5).

```
POST /api/channels/:channelId/reject-invite
```

### Middleware chain (theo thứ tự)
1. `accessTokenValidator` — xác thực JWT, lấy `userId` từ token
2. `validateParams(channelIdSchema)` — validate `channelId` trong URL
3. `checkChannelExistOnly` — channel tồn tại
4. `rejectInviteController` — xử lý (service kiểm tra row `PENDING_INVITE` của caller)

**Lưu ý:** Method này user tự thực hiện, không cần quyền admin/owner.

### Request

**Path params:**

| Field       | Type   | Required | Mô tả                          |
| ----------- | ------ | -------- | ------------------------------ |
| `channelId` | string | ✅       | ID của channel (BigInt string) |

**Body:** Không có.

### Response — `200 OK`

```json
{
  "message": "Từ chối lời mời thành công",
  "data": {
    "channelId": "1745263527180002",
    "userId": "1745263527180001",
    "status": "LEFT",
    "rejectedAt": "2026-10-10T10:30:00.000Z"
  }
}
```

| Field        | Type   | Mô tả                                                |
| ------------ | ------ | ---------------------------------------------------- |
| `channelId`  | string | ID channel                                           |
| `userId`     | string | ID user đã reject (lấy từ JWT)                      |
| `status`     | string | Luôn là `LEFT` (terminal state)                      |
| `rejectedAt` | string | ISO timestamp lúc reject (= thời điểm update status) |

### Side effects
- Update `channelMember.status` từ `PENDING_INVITE` → `LEFT` (giữ row, không xóa để audit).
- **Không ghi đè `joinedAt`** — giữ timestamp cũ của row để truy vết.
- Đồng bộ `workspaceMember` qua helper `syncWorkspaceMember`:
  - Nếu user chưa từng ACTIVE workspace và không còn channel nào ACTIVE/PENDING → xóa row `workspaceMember`.
  - Nếu user đã từng ACTIVE workspace (qua channel khác) → giữ nguyên.
- **KHÔNG emit socket** — frontend nên refetch danh sách.

### Error responses

| Status | Message                                                | Nguyên nhân                                                  |
| ------ | ------------------------------------------------------ | ------------------------------------------------------------ |
| 400    | `ID channel của bạn không được để trống`               | Thiếu `channelId` trong URL                                  |
| 400    | `Không có lời mời nào để từ chối`                      | User chưa từng được mời HOẶC status ≠ PENDING_INVITE        |
| 401    | `Unauthorized`                                         | Thiếu/sai access_token                                       |
| 404    | `Channel không tồn tại`                                | Channel không tồn tại                                       |
| 404    | `Channel không tồn tại hoặc không thuộc workspace nào` | Channel DM hoặc không có workspace                          |

### Example

```bash
curl -X POST https://api.example.com/api/channels/1745263527180002/reject-invite \
  -H "Authorization: Bearer eyJhbGciOi..."
```

---

## So sánh với API tương tự trong invite cá nhân

| Actor    | Action              | Endpoint                                         | Trạng thái cuối cùng |
| -------- | ------------------- | ------------------------------------------------ | -------------------- |
| Admin    | Gửi invite          | `POST /:channelId/invite`                        | `PENDING_INVITE`     |
| Admin    | Thu hồi invite      | `DELETE /:channelId/invites/:userId`             | `LEFT`               |
| **User** | **Accept invite**   | **`POST /:channelId/accept-invite`**             | **`ACTIVE`**         |
| **User** | **Reject invite**   | **`POST /:channelId/reject-invite`**             | **`LEFT`**           |

**So sánh 3 trạng thái terminal — LEFT vs CANCELED vs BANNED:**

| Status     | Ý nghĩa                                              | Actor                                  | Áp dụng cho                              | Có thể phục hồi?          |
| ---------- | ---------------------------------------------------- | -------------------------------------- | ---------------------------------------- | ------------------------- |
| `LEFT`     | **Từ chối / rời** — user chủ động rời                | User                                   | PENDING_INVITE (reject) / ACTIVE (leave) | Có (re-invite / re-join)  |
| `CANCELED` | **Hủy yêu cầu** — hủy trước khi được duyệt          | User (tự hủy) hoặc Admin (từ chối)     | PENDING_REQUEST                          | Có (re-submit request)    |
| `BANNED`   | **Bị cấm** — admin cấm truy cập                      | Admin                                  | Bất kỳ trạng thái nào                    | Có (chỉ admin unban)      |

**Điểm chung:** cả 3 đều là **terminal state**, **giữ row để audit** (không xóa), và **không tính là thành viên hợp lệ** (helper `syncWorkspaceMember` sẽ bỏ qua khi đếm).

**Phân biệt LEFT vs CANCELED khi gặp PENDING:**
- Nhận được `PENDING_INVITE` mà user từ chối → `LEFT`
- Tự gửi `PENDING_REQUEST` mà user hủy (hoặc admin từ chối) → `CANCELED`

**`BANNED` vs `LEFT`:**
- `BANNED` mang tính **trừng phạt**, admin chủ động áp đặt, user không tự rời được.
- `LEFT` là user **tự nguyện** rời (hoặc từ chối invite).

### Lưu ý quan trọng cho Frontend

1. **Phân biệt 2 actor cho invite cá nhân:**
   - **Admin gửi/thu hồi invite** — yêu cầu OWNER/ADMIN channel (xem [docs/channel-invite-api.md](docs/channel-invite-api.md)).
   - **User phản hồi invite** (2 API trong file này) — không cần quyền, userId lấy từ JWT.

2. **Không có socket event** cho 2 API này → frontend phải refetch danh sách sau khi gọi thành công.

3. **`status` enum (6 giá trị):** `PENDING_INVITE | PENDING_REQUEST | ACTIVE | LEFT | CANCELED | BANNED` — dùng để filter UI.

4. **Idempotency:** 2 API KHÔNG idempotent (mỗi lần gọi đều ghi lại `acceptedAt`/`rejectedAt`). Frontend nên debounce button.

5. **`workspaceMember.status` derive** từ tập `channelMember.status` của user trong workspace. Xem chi tiết tại [docs/channel-workspace-member-sync-flows.md](docs/channel-workspace-member-sync-flows.md).

---

## TypeScript types (copy vào FE)

```typescript
// Response data cho POST /:channelId/accept-invite (user tự thực hiện)
export interface AcceptInviteResponse {
  channelId: string
  userId: string
  status: MemberStatus.ACTIVE
  acceptedAt: string
}

// Response data cho POST /:channelId/reject-invite (user tự thực hiện)
export interface RejectInviteResponse {
  channelId: string
  userId: string
  status: MemberStatus.LEFT
  rejectedAt: string
}
```

> Các type dùng chung (`MemberStatus`, `ApiResponse<T>`, ...) xem ở [docs/channel-invite-api.md](docs/channel-invite-api.md).
