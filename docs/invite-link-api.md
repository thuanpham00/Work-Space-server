# API: Invite Link (Mời qua link có hạn)

> Tài liệu cho **Backend** — dùng để implement tính năng tạo link mời vào workspace có thời gian hết hạn (kiểu Slack/Discord invite link).

---

## 1. Tổng quan

So với API `POST /workspaces/:workspaceId/invite` (mời user cụ thể qua `userId`), API Invite Link cho phép **OWNER/ADMIN** tạo ra một URL ngẫu nhiên. Bất kỳ ai click vào URL đó (và đang đăng nhập) sẽ được join vào workspace mà **không cần admin chỉ định userId trước**.

| Đặc điểm | Mô tả |
| --- | --- |
| **Không cần bảng DB** | Token self-contained, dùng **HMAC-SHA256** signed payload |
| **Có hạn** | Mỗi link có `expiresAt` (mặc định 7 ngày) |
| **Multi-use** | Một link có thể được dùng nhiều lần (trừ khi BE thêm `maxUses`) |
| **Role mặc định** | MEMBER (có thể cấu hình khi tạo) |

---

## 2. Kiến trúc đề xuất

### 2.1 Token format

Token là chuỗi ngắn, URL-safe, dạng `base64url(payload).base64url(hmac)`:

```
eyJ3b3Jrc3BhY2VJZCI6IjEyMzQ1Njc4OTAiLCJyb2xlIjoiTUVNQkVSIiwiZXhwIjoxNzM4MjQwMDAwfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
```

Độ dài ~80 ký tự. Có thể gọn hơn nếu encode nhị phân thay vì JSON.

### 2.2 Payload (decoded từ phần đầu của token)

```json
{
  "workspaceId": "1234567890",
  "role": "MEMBER",
  "exp": 1738240000,
  "invitedById": "9876543210"
}
```

| Field | Type | Mô tả |
| --- | --- | --- |
| `workspaceId` | string (bigint) | ID workspace người dùng sẽ join vào |
| `role` | `"MEMBER" \| "ADMIN"` | Role được gán khi join |
| `exp` | number (unix seconds) | Thời điểm hết hạn. Verify bằng `Date.now() / 1000 > exp` |
| `invitedById` | string (bigint) | ID của admin đã tạo link (để audit / hiển thị "Mời bởi ...") |

### 2.3 Signing scheme

```ts
// Pseudocode — tham khảo
const payloadB64 = base64url(JSON.stringify(payload));
const mac = hmacSHA256(payloadB64, INVITE_SECRET);
const token = `${payloadB64}.${base64url(mac)}`;

// Verify: tính lại HMAC từ payloadB64, so sánh timing-safe với mac trong token
// Sau đó check exp
```

### 2.4 ENV cần thêm

```env
# Khác JWT_SECRET của auth — không dùng chung
INVITE_SECRET=<random-64-bytes-hex>
INVITE_LINK_TTL_DEFAULT=604800   # 7 ngày (seconds)
```

---

## 3. Endpoint

### 3.1 Tạo invite link

```
POST /workspaces/:workspaceId/invite-link
```

**Auth:** Bearer Access Token (bắt buộc).

**Quyền:** Chỉ **OWNER / ADMIN ACTIVE** của workspace mới được gọi. Member thường → `403 Forbidden`.

**Idempotency:** Mỗi lần gọi tạo token mới (token cũ vẫn valid nếu chưa hết hạn). Nếu muốn revoke token cũ, xem §3.4.

### 3.2 Lấy thông tin invite link (preview trước khi join)

```
GET /invite/:token
```

**Auth:** Bearer Access Token (bắt buộc — cần biết user hiện tại để check đã là member chưa).

**Công khai về token:** Bất kỳ ai có token đều gọi được. Token là bearer credential — server chỉ cần verify chữ ký + exp.

### 3.3 Chấp nhận invite link (join workspace)

```
POST /invite/:token/accept
```

**Auth:** Bearer Access Token (bắt buộc).

**Hành vi:** Tạo row `WorkspaceMember` mới (status `JOINED`) hoặc update row cũ nếu user trước đó `LEFT / REJECTED / CANCELLED`.

### 3.4 (Optional) Revoke invite link

```
DELETE /workspaces/:workspaceId/invite-link
```

**Mục đích:** Vô hiệu hóa **tất cả** link chưa hết hạn của workspace. Lưu `revokedAt` vào 1 row marker hoặc dùng `revokedBefore` timestamp để check lúc verify.

> ⚠️ Implement tuỳ chọn — pattern HMAC thuần không cho phép revoke đơn lẻ. Nếu cần revoke theo từng link, hãy lưu token vào DB (xem §10).

---

## 4. Request Headers

```
Authorization: Bearer <access_token>
Content-Type: application/json
```

---

## 5. Path Params & Body

### 5.1 POST /workspaces/:workspaceId/invite-link

**Path Params:**

| Field | Type | Required | Mô tả |
| --- | --- | --- | --- |
| `workspaceId` | string (bigint) | ✅ | ID workspace |

**Body (tất cả optional):**

```json
{
  "role": "MEMBER",
  "ttlSeconds": 604800
}
```

| Field | Type | Required | Mặc định | Mô tả |
| --- | --- | --- | --- | --- |
| `role` | `"MEMBER" \| "ADMIN"` | ❌ | `"MEMBER"` | Role gán cho người join qua link |
| `ttlSeconds` | number | ❌ | `604800` (7 ngày) | TTL tính bằng giây. Tối đa khuyến nghị `2592000` (30 ngày) |

### 5.2 GET /invite/:token

**Path Params:**

| Field | Type | Required | Mô tả |
| --- | --- | --- | --- |
| `token` | string | ✅ | Token nhận được từ bước tạo link |

### 5.3 POST /invite/:token/accept

**Path Params:**

| Field | Type | Required | Mô tả |
| --- | --- | --- | --- |
| `token` | string | ✅ | Token nhận được từ bước tạo link |

**Body:** không cần (user lấy từ access token).

---

## 6. Response Shape

### 6.1 Success — Tạo link (200 OK)

```jsonc
HTTP/1.1 200 OK
{
  "data": {
    "token": "eyJ3b3Jrc3BhY2VJZCI6IjEyMzQ1Njc4OTAiLCJyb2xlIjoiTUVNQkVSIiwiZXhwIjoxNzM4MjQwMDAwfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "url": "https://app.example.com/invite/eyJ3b3Jrc3BhY2VJZCI6IjEyMzQ1Njc4OTAiLCJyb2xlIjoiTUVNQkVSIiwiZXhwIjoxNzM4MjQwMDAwfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "workspaceId": "1234567890",
    "role": "MEMBER",
    "expiresAt": "2026-10-04T15:30:00.000Z",
    "invitedById": "9876543210",
    "createdAt": "2026-09-27T15:30:00.000Z"
  }
}
```

### 6.2 Success — Preview link (200 OK)

```jsonc
HTTP/1.1 200 OK
{
  "data": {
    "workspace": {
      "id": "1234567890",
      "name": "Đội phát triển Frontend",
      "avatarUrl": "https://cdn.example.com/workspaces/1234567890.png"
    },
    "role": "MEMBER",
    "expiresAt": "2026-10-04T15:30:00.000Z",
    "invitedBy": {
      "id": "9876543210",
      "displayName": "Nguyễn Văn A",
      "avatarUrl": "https://cdn.example.com/users/9876543210.png"
    },
    "alreadyMember": false
  }
}
```

`alreadyMember: true` nếu user hiện tại đã là member của workspace → FE có thể skip bước "Accept" và chuyển thẳng vào workspace.

### 6.3 Success — Accept link (200 OK)

```jsonc
HTTP/1.1 200 OK
{
  "data": {
    "workspace": {
      "id": "1234567890",
      "name": "Đội phát triển Frontend",
      "avatarUrl": "https://cdn.example.com/workspaces/1234567890.png"
    },
    "workspaceMember": {
      "id": "1122334455",
      "workspaceId": "1234567890",
      "userId": "5556667778",
      "role": "MEMBER",
      "status": "JOINED",
      "joinedAt": "2026-09-27T16:00:00.000Z",
      "invitedById": "9876543210",
      "requestedById": "5556667778",
      "approvedById": "9876543210",
      "approvedByType": "ADMIN"
    }
  }
}
```

---

## 7. Lỗi

### 7.1 Token không hợp lệ / sai chữ ký

```jsonc
HTTP/1.1 400 Bad Request
{
  "message": "Invite link không hợp lệ"
}
```

### 7.2 Token hết hạn

```jsonc
HTTP/1.1 410 Gone
{
  "message": "Invite link đã hết hạn"
}
```

### 7.3 Token đã bị revoke (nếu implement §3.4)

```jsonc
HTTP/1.1 410 Gone
{
  "message": "Invite link đã bị thu hồi"
}
```

### 7.4 User đã là thành viên

Khi gọi `POST /accept` mà user đã là member với status `JOINED`:

```jsonc
HTTP/1.1 409 Conflict
{
  "message": "Bạn đã là thành viên của workspace này"
}
```

### 7.5 Workspace không tồn tại / đã bị xoá

```jsonc
HTTP/1.1 404 Not Found
{
  "message": "Workspace không tồn tại"
}
```

### 7.6 Không đủ quyền tạo link

```jsonc
HTTP/1.1 403 Forbidden
{
  "message": "Bạn không đủ quyền cho thao tác này"
}
```

### 7.7 Chưa đăng nhập

```jsonc
HTTP/1.1 401 Unauthorized
{
  "message": "Vui lòng đăng nhập"
}
```

### 7.8 TTL vượt quá giới hạn

```jsonc
HTTP/1.1 400 Bad Request
{
  "message": "TTL không được vượt quá 30 ngày"
}
```

---

## 8. Logic Backend (gợi ý implementation)

### 8.1 Pseudocode — `signInviteLink`

```ts
import { createHmac } from 'crypto';

const SECRET = process.env.INVITE_SECRET!;

interface InvitePayload {
  workspaceId: string;
  role: 'MEMBER' | 'ADMIN';
  exp: number;
  invitedById: string;
}

export function signInviteLink(
  workspaceId: string,
  role: 'MEMBER' | 'ADMIN',
  ttlSeconds: number,
  invitedById: string,
): string {
  const payload: InvitePayload = {
    workspaceId,
    role,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    invitedById,
  };

  // Canonicalize payload trước khi sign
  const payloadB64 = Buffer
    .from(JSON.stringify(payload))
    .toString('base64url');

  const mac = createHmac('sha256', SECRET)
    .update(payloadB64)
    .digest('base64url');

  return `${payloadB64}.${mac}`;
}
```

### 8.2 Pseudocode — `verifyInviteLink`

```ts
import { createHmac, timingSafeEqual } from 'crypto';

const SECRET = process.env.INVITE_SECRET!;

export function verifyInviteLink(token: string): InvitePayload {
  const parts = token.split('.');
  if (parts.length !== 2) throw new InvalidTokenError();

  const [payloadB64, macB64] = parts;

  // 1. Verify signature
  const expectedMac = createHmac('sha256', SECRET)
    .update(payloadB64)
    .digest('base64url');

  const macBuf = Buffer.from(macB64);
  const expectedBuf = Buffer.from(expectedMac);
  if (
    macBuf.length !== expectedBuf.length ||
    !timingSafeEqual(macBuf, expectedBuf)
  ) {
    throw new InvalidTokenError();
  }

  // 2. Parse payload
  let payload: InvitePayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    );
  } catch {
    throw new InvalidTokenError();
  }

  // 3. Check expiry
  if (Math.floor(Date.now() / 1000) > payload.exp) {
    throw new ExpiredTokenError();
  }

  return payload;
}
```

### 8.3 Pseudocode — Endpoint `POST /:workspaceId/invite-link`

```ts
router.post(
  '/workspaces/:workspaceId/invite-link',
  requireAuth,
  validateWorkspaceAdmin,
  async (req, res) => {
    const { role = 'MEMBER', ttlSeconds = 7 * 24 * 3600 } = req.body;
    const MAX_TTL = 30 * 24 * 3600;

    if (ttlSeconds > MAX_TTL) {
      return res.status(400).json({ message: 'TTL không được vượt quá 30 ngày' });
    }

    const token = signInviteLink(
      req.params.workspaceId,
      role,
      ttlSeconds,
      req.userId,
    );

    return res.json({
      data: {
        token,
        url: `${process.env.APP_URL}/invite/${token}`,
        workspaceId: req.params.workspaceId,
        role,
        expiresAt: new Date((Math.floor(Date.now() / 1000) + ttlSeconds) * 1000),
        invitedById: req.userId,
        createdAt: new Date(),
      },
    });
  },
);
```

### 8.4 Pseudocode — Endpoint `POST /invite/:token/accept`

```ts
router.post(
  '/invite/:token/accept',
  requireAuth,
  async (req, res) => {
    let payload;
    try {
      payload = verifyInviteLink(req.params.token);
    } catch (err) {
      if (err instanceof ExpiredTokenError) {
        return res.status(410).json({ message: 'Invite link đã hết hạn' });
      }
      return res.status(400).json({ message: 'Invite link không hợp lệ' });
    }

    // 1. Check workspace còn tồn tại
    const workspace = await db.workspace.findUnique({
      where: { id: payload.workspaceId },
    });
    if (!workspace || workspace.deletedAt) {
      return res.status(404).json({ message: 'Workspace không tồn tại' });
    }

    // 2. Check user đã là member chưa
    const existing = await db.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: payload.workspaceId,
          userId: req.userId,
        },
      },
    });

    if (existing?.status === 'JOINED') {
      return res.status(409).json({ message: 'Bạn đã là thành viên của workspace này' });
    }

    // 3. Upsert member
    const member = await db.workspaceMember.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: payload.workspaceId,
          userId: req.userId,
        },
      },
      update: {
        status: 'JOINED',
        role: payload.role,
        joinedAt: new Date(),
        approvedById: payload.invitedById,
        approvedByType: 'ADMIN',
      },
      create: {
        workspaceId: payload.workspaceId,
        userId: req.userId,
        role: payload.role,
        status: 'JOINED',
        joinedAt: new Date(),
        invitedById: payload.invitedById,
        requestedById: req.userId,
        approvedById: payload.invitedById,
        approvedByType: 'ADMIN',
      },
    });

    return res.json({
      data: {
        workspace,
        workspaceMember: member,
      },
    });
  },
);
```

---

## 9. Ví dụ curl

### 9.1 Tạo link

```bash
curl -X POST \
  'http://localhost:3000/workspaces/1234567890/invite-link' \
  -H 'Authorization: Bearer eyJhbGciOi...' \
  -H 'Content-Type: application/json' \
  -d '{"role": "MEMBER", "ttlSeconds": 604800}'
```

### 9.2 Preview link (trước khi join)

```bash
curl -X GET \
  'http://localhost:3000/invite/eyJ3b3Jrc3BhY2VJZCI6IjEyMzQ1Njc4OTAiLCJyb2xlIjoiTUVNQkVSIiwiZXhwIjoxNzM4MjQwMDAwfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' \
  -H 'Authorization: Bearer eyJhbGciOi...'
```

### 9.3 Accept link (join workspace)

```bash
curl -X POST \
  'http://localhost:3000/invite/eyJ3b3Jrc3BhY2VJZCI6IjEyMzQ1Njc4OTAiLCJyb2xlIjoiTUVNQkVSIiwiZXhwIjoxNzM4MjQwMDAwfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk/accept' \
  -H 'Authorization: Bearer eyJhbGciOi...'
```

### 9.4 Lỗi — Token hết hạn

```bash
curl -X GET \
  'http://localhost:3000/invite/EXPIRED_TOKEN_HERE' \
  -H 'Authorization: Bearer eyJhbGciOi...'
```

**Response:**

```jsonc
HTTP/1.1 410 Gone
{
  "message": "Invite link đã hết hạn"
}
```

---

## 10. Tuỳ chọn nâng cao

### 10.1 Revoke một link cụ thể (cần DB)

Pattern HMAC thuần không cho revoke từng link. Nếu cần, thêm bảng:

```prisma
model InviteLink {
  id          String   @id @default(cuid())
  token       String   @unique
  workspaceId String
  createdById String
  expiresAt   DateTime
  maxUses     Int?
  usedCount   Int      @default(0)
  revokedAt   DateTime?
  createdAt   DateTime @default(now())
}
```

- Khi tạo link → lưu cả `token` vào DB
- Khi verify → check `revokedAt IS NULL AND expiresAt > NOW() AND (maxUses IS NULL OR usedCount < maxUses)`
- Revoke: `UPDATE InviteLink SET revokedAt = NOW() WHERE id = ?`

### 10.2 Giới hạn số lần dùng (`maxUses`)

Khi accept, increment `usedCount`. Nếu vượt `maxUses` → trả `410 Gone`.

### 10.3 Single-use link

Set `maxUses = 1` khi tạo → tự xóa row sau khi `usedCount = 1`.

### 10.4 Audit log

```prisma
model InviteLinkAudit {
  id          String   @id @default(cuid())
  token       String
  action      String   // 'CREATED' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED'
  actorId     String?
  metadata    Json?
  createdAt   DateTime @default(now())
}
```

---

## 11. Notes cho Frontend

### 11.1 Hiển thị link

- Sau khi tạo link, hiển thị URL đầy đủ + nút "Sao chép"
- Hiển thị **countdown** "Hết hạn sau X ngày Y giờ" dựa trên `expiresAt` (chỉ là UX, server vẫn verify lại)
- Khi countdown về 0 → ẩn link, hiển thị nút "Tạo link mới"

### 11.2 Trang `/invite/:token`

Flow khuyến nghị:

```
1. User click link https://app.com/invite/TOKEN
2. Nếu chưa login → redirect /login?redirect=/invite/TOKEN
3. Nếu đã login → gọi GET /invite/:token (preview)
4. Hiển thị:
   - Tên + avatar workspace
   - "Mời bởi <tên admin>"
   - "Hết hạn lúc <datetime>"
   - Nút "Tham gia workspace" → gọi POST /invite/:token/accept
5. Nếu alreadyMember=true → skip nút, hiển thị "Bạn đã là thành viên" + nút "Mở workspace"
```

### 11.3 Error UX mapping

| Status | Message hiển thị |
| --- | --- |
| `400 — Invite link không hợp lệ` | "Link không hợp lệ hoặc đã bị xoá" |
| `410 — Invite link đã hết hạn` | "Link đã hết hạn. Vui lòng yêu cầu admin gửi lại" |
| `410 — Invite link đã bị thu hồi` | "Link đã bị thu hồi bởi admin" |
| `409 — Bạn đã là thành viên` | "Bạn đã ở trong workspace này rồi" |
| `404 — Workspace không tồn tại` | "Workspace không còn tồn tại" |

### 11.4 Không hiển thị nút tạo link cho MEMBER thường

Chỉ render UI trong `WorkspaceMemberModal` / `InviteMemberWorkspaceModal` khi `currentUser.role === 'OWNER' || 'ADMIN'`.

---

## 12. So sánh với API Invite cũ

| | `POST /workspaces/:id/invite` | `POST /workspaces/:id/invite-link` |
| --- | --- | --- |
| **Đối tượng** | User cụ thể (qua `userId`) | Bất kỳ ai có link |
| **Cần biết userId?** | Có | Không |
| **Có hạn?** | Có (PENDING_INVITE chờ user accept) | Có (TTL link) |
| **Cần DB?** | Có (row PENDING_INVITE) | Không (HMAC) |
| **Multi-use?** | Không (1 user) | Có (nhiều user qua cùng 1 link) |
| **Use case** | Mời người quen cụ thể | Chia sẻ cho cả nhóm / đăng lên Slack |

→ **Cả 2 API cùng tồn tại**, dùng cho 2 scenario khác nhau.
