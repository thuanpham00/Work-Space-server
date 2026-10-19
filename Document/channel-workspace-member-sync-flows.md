# Channel ↔ Workspace Member Sync Rule

> Rule đồng bộ `channelMember.status` ↔ `workspaceMember.status` cho mọi thao tác liên quan đến **request / invite / approve / reject / leave / kick / ban** channel.
>
> Áp dụng cho code trong `src/services/channel.services.ts` (và các service liên quan sắp tới).
>
> ⚠️ **Đã bổ sung**: status `CANCELED` (thay cho `MUTED` cũ) dùng cho case user tự hủy `PENDING_REQUEST`.

---

## 1. Enum & ý nghĩa

```prisma
enum MemberStatus {
  ACTIVE          // Đang thực sự thuộc channel / workspace
  LEFT            // Đã từng ACTIVE, rồi tự rời (chỉ áp dụng cho channelMember)
  BANNED          // Bị admin kick khỏi channel
  PENDING_REQUEST // User gửi request join → chờ admin duyệt
  PENDING_INVITE  // Admin gửi invite → chờ user accept
  CANCELED        // (chỉ channelMember) User đã hủy request PENDING_REQUEST của mình
}
```

### Phân biệt theo loại row

| Status | channelMember | workspaceMember | Ghi chú |
|---|---|---|---|
| `ACTIVE` | ✅ | ✅ | User thực sự tham gia |
| `LEFT` | ✅ | ✅ | Channel: rời channel. Workspace: rời hết channel cuối cùng → derive. |
| `BANNED` | ✅ | ✅ | Channel: bị admin kick. Workspace: bị ban khỏi mọi channel → derive. |
| `PENDING_REQUEST` | ✅ | ✅ | Đang chờ duyệt (cùng chiều) |
| `PENDING_INVITE` | ✅ | ✅ | Đang được mời (cùng chiều) |
| `CANCELED` | ✅ | ❌ | **Chỉ có ở channelMember**, KHÔNG ảnh hưởng workspaceMember (terminal state cho 1 request, không liên quan đến workspace). |

---

## 2. Invariant

> **`workspaceMember.status` = derive từ tập `channelMember.status` của user trong cùng workspace.**

```
n_active    = count(channelMember WHERE userId = ? AND channel.workspaceId = ? AND status = ACTIVE)
n_pending   = count(channelMember WHERE userId = ? AND channel.workspaceId = ? AND status IN [PENDING_REQUEST, PENDING_INVITE])
n_banned    = count(channelMember WHERE userId = ? AND channel.workspaceId = ? AND status = BANNED)
n_canceled  = count(channelMember WHERE userId = ? AND channel.workspaceId = ? AND status = CANCELED)
n_left      = count(channelMember WHERE userId = ? AND channel.workspaceId = ? AND status = LEFT)

# Quy tắc derive (theo thứ tự ưu tiên)
if n_active > 0:           workspaceMember.status = ACTIVE
elif n_pending > 0:        workspaceMember.status = PENDING_REQUEST   (hoặc PENDING_INVITE nếu chỉ có invite)
elif n_banned > 0:         workspaceMember.status = BANNED
else:                      workspaceMember.status = LEFT                # hoặc KHÔNG CÓ ROW (xem §2.1)
```

### 2.1 Quy tắc "có row hay không"

- **`workspaceMember` chỉ tồn tại** khi user **đã từng có ít nhất 1 row channelMember** trong workspace (kể cả các row đã `LEFT`/`BANNED`/`CANCELED`).
- Khi xóa row channelMember (cancel request, reject request…) → gọi helper để xem lại workspaceMember:
  - Nếu user **chưa từng ACTIVE** workspace (tất cả channelMember đều ở terminal state `LEFT`/`BANNED`/`CANCELED`) → **xóa luôn row `workspaceMember`**.
  - Nếu user **đã từng ACTIVE** workspace và đang rời từng channel → `workspaceMember.status = LEFT` (giữ row, không xóa).
- Khi user **accept invite thẳng vào channel** mà chưa từng có row → **tạo mới** workspaceMember với `status = ACTIVE`.

### 2.2 Vai trò của `CANCELED`

`CANCELED` là **terminal state cục bộ** cho 1 channelMember:
- User gửi `PENDING_REQUEST` → `channelMember.status = PENDING_REQUEST`.
- User hủy request → update `channelMember.status = CANCELED` (giữ row, không xóa).
- Lý do giữ row: audit trail (biết user đã từng request channel này nhưng tự rút lui), tránh cho user spam request liên tục.

→ `CANCELED` **không** xuất hiện trong `workspaceMember.status`, không ảnh hưởng derive rule.

---

## 3. Bảng transition rule cho từng flow

Mỗi flow mô tả:
- **Trigger**: action người dùng / admin.
- **channelMember**: thay đổi gì.
- **workspaceMember**: thay đổi gì (gọi helper `syncWorkspaceMember`).
- **Gọi helper?**: bắt buộc hay tùy chọn.

| # | Flow | Trigger | channelMember | workspaceMember | Gọi helper? |
|---|---|---|---|---|---|
| 1 | **Request join** (user) | User gửi request vào channel public | `INSERT/UPDATE status = PENDING_REQUEST` | Tạo mới `PENDING_REQUEST` nếu chưa có; hoặc update từ `LEFT`/`BANNED` → `PENDING_REQUEST`; hoặc giữ `ACTIVE` (nếu đang ACTIVE workspace). | **Có** |
| 2 | **Cancel join request** (user) | User hủy request đang PENDING_REQUEST | `UPDATE status = CANCELED` (giữ row) | Nếu user đã từng ACTIVE workspace → giữ status hiện tại. Nếu chưa từng → xóa row. | **Có** |
| 3 | **Invite user** (admin) | Admin gửi invite vào channel | `INSERT status = PENDING_INVITE, invitedById = admin` | Tương tự flow #1, nhưng `PENDING_INVITE` thay vì `PENDING_REQUEST`. | **Có** |
| 4 | **Accept invite** (user) | User chấp nhận lời mời | `UPDATE status = ACTIVE` | Nếu user chưa từng ACTIVE workspace → tạo mới `ACTIVE`. Ngược lại giữ `ACTIVE`. | **Có** |
| 5 | **Reject invite** (user) | User từ chối lời mời | `UPDATE status = LEFT` (terminal) | Tương tự flow #2 với `LEFT`. | **Có** |
| 6 | **Revoke invite** (admin) | Admin thu hồi lời mời | `UPDATE status = LEFT` (terminal) | Tương tự flow #5. | **Có** |
| 7 | **Approve request** (admin) | Admin duyệt PENDING_REQUEST | `UPDATE status = ACTIVE` | Update `workspaceMember.status = ACTIVE` (hoặc tạo mới). | **Có** |
| 8 | **Reject request** (admin) | Admin từ chối PENDING_REQUEST | `UPDATE status = CANCELED` | Tương tự flow #2 với `CANCELED`. | **Có** |
| 9 | **Leave channel ACTIVE** (user) | User tự rời | `UPDATE status = LEFT` | Nếu đây là channel ACTIVE cuối → `workspaceMember.status = LEFT` (giữ row). Nếu còn channel ACTIVE khác → giữ `ACTIVE`. | **Có** |
| 10 | **Kick / Ban channel ACTIVE** (admin) | Admin kick user | `UPDATE status = BANNED` | Tương tự flow #9 với `BANNED`. | **Có** |
| 11 | **Unban user** (admin) | Admin bỏ ban | `UPDATE status = ACTIVE` (nếu còn muốn cho vào) hoặc xóa row | Nếu chuyển sang ACTIVE → `workspaceMember.status = ACTIVE`. Nếu xóa row → gọi helper. | **Có** |

---

## 4. Helper function (bắt buộc dùng cho mọi flow)

Đặt helper trong `src/services/channel.services.ts` (private static hoặc method riêng của `ChannelService`).

```ts
import { Prisma } from '~/generated/prisma/client'
import { MemberStatus, WorkspaceMemberRole } from '~/constants/enum'

/**
 * Đồng bộ workspaceMember dựa trên trạng thái tất cả channelMember của user trong workspace.
 * 
 * Quy tắc:
 * 1. Nếu có channelMember ACTIVE → workspaceMember.status = ACTIVE (giữ row hoặc tạo mới).
 * 2. Nếu có channelMember PENDING_REQUEST/PENDING_INVITE → workspaceMember.status = PENDING_REQUEST.
 * 3. Nếu chỉ có BANNED → workspaceMember.status = BANNED.
 * 4. Nếu không còn row nào (LEFT/BANNED/CANCELED hết) VÀ user chưa từng ACTIVE workspace 
 *    → XÓA row workspaceMember (nếu có).
 * 5. Nếu không còn row nào VÀ user đã từng ACTIVE → workspaceMember.status = LEFT (giữ row audit).
 * 
 * Phải gọi trong transaction (truyền `tx`).
 */
async function syncWorkspaceMember(
  tx: Prisma.TransactionClient,
  workspaceId: bigint,
  userId: bigint
): Promise<void> {
  // 1. Đếm channelMember theo status
  const [nActive, nPending, nBanned, nEverActive] = await Promise.all([
    tx.channelMember.count({
      where: {
        userId,
        status: MemberStatus.ACTIVE,
        channel: { workspaceId }
      }
    }),
    tx.channelMember.count({
      where: {
        userId,
        status: { in: [MemberStatus.PENDING_REQUEST, MemberStatus.PENDING_INVITE] },
        channel: { workspaceId }
      }
    }),
    tx.channelMember.count({
      where: {
        userId,
        status: MemberStatus.BANNED,
        channel: { workspaceId }
      }
    }),
    // Kiểm tra user đã từng ACTIVE workspace chưa (qua channelMember ACTIVE/LEFT/BANNED cũ)
    tx.channelMember.count({
      where: {
        userId,
        status: { in: [MemberStatus.ACTIVE, MemberStatus.LEFT, MemberStatus.BANNED] },
        channel: { workspaceId }
      }
    })
  ])

  // 2. Lookup workspaceMember hiện tại
  const wsMember = await tx.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } }
  })

  // 3. Tính status mới theo thứ tự ưu tiên
  let newStatus: MemberStatus | null
  if (nActive > 0) {
    newStatus = MemberStatus.ACTIVE
  } else if (nPending > 0) {
    newStatus = MemberStatus.PENDING_REQUEST
  } else if (nBanned > 0) {
    newStatus = MemberStatus.BANNED
  } else if (nEverActive > 0) {
    newStatus = MemberStatus.LEFT  // giữ row audit
  } else {
    newStatus = null  // xóa row
  }

  // 4. Áp dụng
  if (newStatus === null) {
    // Xóa row nếu có
    if (wsMember) {
      await tx.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId, userId } }
      })
    }
    return
  }

  if (!wsMember) {
    // Tạo mới
    await tx.workspaceMember.create({
      data: {
        workspaceId,
        userId,
        role: WorkspaceMemberRole.MEMBER,
        status: newStatus,
        joinedAt: new Date()
      }
    })
    return
  }

  // Update nếu status thay đổi
  if (wsMember.status !== newStatus) {
    await tx.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: { status: newStatus }
    })
  }
}
```

---

## 5. Áp dụng cho từng flow (code skeleton)

### 5.1 `requestJoinChannel(channelId, userId)` — Flow #1

```ts
async requestJoinChannel(channelId: bigint, userId: bigint) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true, isPrivate: true, type: true }
    })
    if (!channel?.workspaceId) throw new BadRequestError('Channel không hợp lệ')
    if (channel.type === DM) throw new BadRequestError('Không thể request vào DM')
    if (channel.isPrivate) throw new ForbiddenError('Channel private chỉ được mời')

    const existing = await tx.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })

    if (existing?.status === ACTIVE) throw new BadRequestError('Bạn đã là thành viên')
    if (existing?.status === PENDING_REQUEST) throw new BadRequestError('Đã gửi request trước đó')
    if (existing?.status === PENDING_INVITE) throw new BadRequestError('Bạn có lời mời, phản hồi trước')

    // Upsert channelMember PENDING_REQUEST
    await tx.channelMember.upsert({
      where: { channelId_userId: { channelId, userId } },
      create: {
        channelId, userId,
        role: MEMBER,
        status: PENDING_REQUEST,
        joinedAt: new Date()
      },
      update: {
        status: PENDING_REQUEST,
        requestedById: userId,
        joinedAt: new Date()
      }
    })

    // Đồng bộ workspaceMember
    await syncWorkspaceMember(tx, channel.workspaceId, userId)

    return { channelId: channelId.toString(), status: 'PENDING_REQUEST' }
  })
}
```

### 5.2 `cancelJoinRequest(channelId, userId)` — Flow #2

```ts
async cancelJoinRequest(channelId: bigint, userId: bigint) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true }
    })
    if (!channel?.workspaceId) throw new NotFoundError('Channel không tồn tại')

    const member = await tx.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })
    if (!member) throw new NotFoundError('Không có yêu cầu nào')
    if (member.status !== PENDING_REQUEST) {
      throw new BadRequestError('Chỉ hủy được request đang pending')
    }

    // Update → CANCELED (giữ row audit)
    await tx.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { status: CANCELED }
    })

    await syncWorkspaceMember(tx, channel.workspaceId, userId)

    return { channelId: channelId.toString(), status: 'CANCELED' }
  })
}
```

### 5.3 `inviteUserToChannel(channelId, userId, invitedById)` — Flow #3

```ts
async inviteUserToChannel(channelId: bigint, userId: bigint, invitedById: bigint) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true }
    })
    if (!channel?.workspaceId) throw new NotFoundError('Channel không tồn tại')

    const existing = await tx.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })
    if (existing?.status === ACTIVE) throw new BadRequestError('User đã là thành viên')
    if (existing?.status === PENDING_INVITE) throw new BadRequestError('Đã có lời mời')

    await tx.channelMember.upsert({
      where: { channelId_userId: { channelId, userId } },
      create: {
        channelId, userId,
        role: MEMBER,
        status: PENDING_INVITE,
        invitedById,
        joinedAt: new Date()
      },
      update: {
        status: PENDING_INVITE,
        invitedById,
        joinedAt: new Date()
      }
    })

    await syncWorkspaceMember(tx, channel.workspaceId, userId)

    return { channelId: channelId.toString(), status: 'PENDING_INVITE' }
  })
}
```

### 5.4 `acceptInvite(channelId, userId)` — Flow #4

```ts
async acceptInvite(channelId: bigint, userId: bigint) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true }
    })
    if (!channel?.workspaceId) throw new NotFoundError('Channel không tồn tại')

    const member = await tx.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })
    if (!member) throw new NotFoundError('Không có lời mời nào')
    if (member.status !== PENDING_INVITE) {
      throw new BadRequestError('Chỉ accept được lời mời đang pending')
    }

    await tx.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { status: ACTIVE, joinedAt: new Date() }
    })

    await syncWorkspaceMember(tx, channel.workspaceId, userId)

    return { channelId: channelId.toString(), status: 'ACTIVE' }
  })
}
```

### 5.5 `rejectInvite(channelId, userId)` — Flow #5

```ts
async rejectInvite(channelId: bigint, userId: bigint) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true }
    })
    if (!channel?.workspaceId) throw new NotFoundError('Channel không tồn tại')

    const member = await tx.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })
    if (!member || member.status !== PENDING_INVITE) {
      throw new BadRequestError('Không có lời mời để từ chối')
    }

    await tx.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { status: LEFT }
    })

    await syncWorkspaceMember(tx, channel.workspaceId, userId)

    return { channelId: channelId.toString(), status: 'LEFT' }
  })
}
```

### 5.6 `revokeInvite(channelId, userId)` — Flow #6 (admin)

Tương tự `rejectInvite`, status cuối cùng là `LEFT`.

### 5.7 `approveJoinRequest(channelId, userId, approvedById)` — Flow #7

```ts
async approveJoinRequest(channelId: bigint, userId: bigint, approvedById: bigint) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true }
    })
    if (!channel?.workspaceId) throw new NotFoundError('Channel không tồn tại')

    const member = await tx.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })
    if (!member || member.status !== PENDING_REQUEST) {
      throw new BadRequestError('Không có request pending để duyệt')
    }

    await tx.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { 
        status: ACTIVE,
        invitedById: approvedById,
        joinedAt: new Date()
      }
    })

    await syncWorkspaceMember(tx, channel.workspaceId, userId)

    return { channelId: channelId.toString(), status: 'ACTIVE' }
  })
}
```

### 5.8 `rejectJoinRequest(channelId, userId)` — Flow #8 (admin)

```ts
async rejectJoinRequest(channelId: bigint, userId: bigint) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true }
    })
    if (!channel?.workspaceId) throw new NotFoundError('Channel không tồn tại')

    const member = await tx.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })
    if (!member || member.status !== PENDING_REQUEST) {
      throw new BadRequestError('Không có request pending để từ chối')
    }

    // Admin từ chối → CANCELED (giống user tự hủy)
    await tx.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { status: CANCELED }
    })

    await syncWorkspaceMember(tx, channel.workspaceId, userId)

    return { channelId: channelId.toString(), status: 'CANCELED' }
  })
}
```

### 5.9 `leaveChannel(channelId, userId)` — Flow #9

```ts
async leaveChannel(channelId: bigint, userId: bigint) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true }
    })
    if (!channel?.workspaceId) throw new NotFoundError('Channel không tồn tại')

    const member = await tx.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })
    if (!member || member.status !== ACTIVE) {
      throw new BadRequestError('Bạn không phải thành viên ACTIVE của channel này')
    }

    await tx.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { status: LEFT }
    })

    await syncWorkspaceMember(tx, channel.workspaceId, userId)

    return { channelId: channelId.toString(), status: 'LEFT' }
  })
}
```

### 5.10 `kickFromChannel(channelId, userId, kickedById)` — Flow #10

```ts
async kickFromChannel(channelId: bigint, userId: bigint, kickedById: bigint) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true }
    })
    if (!channel?.workspaceId) throw new NotFoundError('Channel không tồn tại')

    const member = await tx.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })
    if (!member || member.status !== ACTIVE) {
      throw new BadRequestError('User không phải thành viên ACTIVE')
    }

    await tx.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { 
        status: BANNED,
        invitedById: kickedById  // lưu admin đã kick
      }
    })

    await syncWorkspaceMember(tx, channel.workspaceId, userId)

    return { channelId: channelId.toString(), status: 'BANNED' }
  })
}
```

### 5.11 `unbanFromChannel(channelId, userId)` — Flow #11

```ts
async unbanFromChannel(channelId: bigint, userId: bigint) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true }
    })
    if (!channel?.workspaceId) throw new NotFoundError('Channel không tồn tại')

    const member = await tx.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })
    if (!member || member.status !== BANNED) {
      throw new BadRequestError('User không bị BANNED ở channel này')
    }

    // Unban → xóa row để user có thể request lại từ đầu (audit trail vẫn còn qua LEFT/BANNED log)
    // Hoặc set về ACTIVE nếu muốn user join lại ngay (tùy nghiệp vụ)
    await tx.channelMember.delete({
      where: { channelId_userId: { channelId, userId } }
    })

    await syncWorkspaceMember(tx, channel.workspaceId, userId)

    return { channelId: channelId.toString(), status: 'UNBANNED' }
  })
}
```

---

## 6. Bảng tổng hợp transition

| Flow | channelMember trước | channelMember sau | workspaceMember trước | workspaceMember sau |
|---|---|---|---|---|
| **#1 Request join #ch1** (chưa từng) | (không có) | PENDING_REQUEST | (không có) | Tạo PENDING_REQUEST |
| **#1 Request join #ch1** (đã ACTIVE ws) | (không có ở ch1) | PENDING_REQUEST | ACTIVE | Giữ ACTIVE |
| **#2 Cancel request** (chưa từng ACTIVE) | PENDING_REQUEST | CANCELED | PENDING_REQUEST | Xóa row |
| **#2 Cancel request** (đã ACTIVE ws) | PENDING_REQUEST | CANCELED | ACTIVE | Giữ ACTIVE |
| **#3 Invite user** (chưa từng) | (không có) | PENDING_INVITE | (không có) | Tạo PENDING_REQUEST |
| **#4 Accept invite** (chưa từng) | PENDING_INVITE | ACTIVE | PENDING_REQUEST | ACTIVE |
| **#4 Accept invite** (chưa từng ws) | PENDING_INVITE | ACTIVE | (không có) | Tạo ACTIVE |
| **#5 Reject invite** (chưa từng ACTIVE) | PENDING_INVITE | LEFT | PENDING_REQUEST | Xóa row |
| **#6 Revoke invite** | PENDING_INVITE | LEFT | PENDING_REQUEST | Xóa row / LEFT |
| **#7 Approve request** (chưa từng) | PENDING_REQUEST | ACTIVE | PENDING_REQUEST | ACTIVE |
| **#8 Reject request** | PENDING_REQUEST | CANCELED | PENDING_REQUEST | Xóa row |
| **#9 Leave** (còn channel ACTIVE khác) | ACTIVE | LEFT | ACTIVE | Giữ ACTIVE |
| **#9 Leave** (channel ACTIVE cuối) | ACTIVE | LEFT | ACTIVE | LEFT (giữ row) |
| **#10 Kick** (còn channel ACTIVE khác) | ACTIVE | BANNED | ACTIVE | Giữ ACTIVE |
| **#10 Kick** (channel ACTIVE cuối) | ACTIVE | BANNED | ACTIVE | BANNED (giữ row) |
| **#11 Unban** (chuyển sang ACTIVE) | BANNED | ACTIVE / (xóa) | BANNED | ACTIVE / xóa row |

---

## 7. Lưu ý quan trọng

1. **OWNER không tạo row `workspaceMember`**: Dùng `workspace.ownerId` làm nguồn duy nhất → không cần sync cho OWNER.

2. **Luôn gọi helper trong transaction**: Mọi thay đổi `channelMember` phải đi kèm `syncWorkspaceMember(tx, workspaceId, userId)` trong cùng `$transaction`.

3. **`invitedById` / `requestedById` trên `workspaceMember`**: Hiện schema có sẵn 2 field nullable này → nên set khi có:
   - `invitedById`: khi user vào workspace lần đầu qua **invite** (PENDING_INVITE → ACTIVE).
   - `requestedById`: khi user vào workspace lần đầu qua **request** (PENDING_REQUEST → ACTIVE).
   - Khi đã ACTIVE → không update 2 field này nữa.

4. **`CANCELED` chỉ ở channelMember**: Không bao giờ ghi `CANCELED` vào `workspaceMember`.

5. **Cleanup `CANCELED`/`LEFT` rows** (optional): Sau 30/90 ngày có thể chạy cron xóa các row `CANCELED`/`LEFT` của channelMember để giảm DB size (audit trail vẫn còn ở logs).

6. **Race condition**: Helper count + update không atomic. Nếu 2 transaction cùng đụng 1 user (vd: admin approve + user cancel đồng thời) có thể race. Trade-off:
   - Option A: Dùng `SERIALIZABLE` isolation → chậm hơn.
   - Option B: Accept race condition nhỏ (1-2 trong 1000 case). Helper idempotent nên retry sẽ OK.
   - Recommendation: **Option B** cho MVP, upgrade sau nếu cần.

---

## 8. Test case cần cover

| # | Setup | Action | Expected workspaceMember | Expected channelMember |
|---|---|---|---|---|
| 1 | User mới, chưa có gì | Request join #ch1 | Tạo `PENDING_REQUEST` | #ch1: PENDING_REQUEST |
| 2 | Như case 1 | Cancel request | **Xóa row** | #ch1: CANCELED |
| 3 | Như case 1 | Admin approve | Update `PENDING_REQUEST` → `ACTIVE` | #ch1: ACTIVE |
| 4 | Như case 1 | Admin reject | **Xóa row** | #ch1: CANCELED |
| 5 | User có #chA ACTIVE | Request join #ch1 | Giữ `ACTIVE` | #ch1: PENDING_REQUEST, #chA: ACTIVE |
| 6 | Như case 5 | Cancel request | Giữ `ACTIVE` | #ch1: CANCELED, #chA: ACTIVE |
| 7 | User có #chA ACTIVE | Admin approve #ch1 | Giữ `ACTIVE` | #ch1: ACTIVE, #chA: ACTIVE |
| 8 | User có #chA ACTIVE | Leave #chA (còn #chB ACTIVE) | Giữ `ACTIVE` | #chA: LEFT, #chB: ACTIVE |
| 9 | User có #chA ACTIVE (channel duy nhất) | Leave #chA | Update → `LEFT` (giữ row) | #chA: LEFT |
| 10 | User đang LEFT workspace (audit) | Request join #ch1 | Tạo `PENDING_REQUEST` | #ch1: PENDING_REQUEST |
| 11 | Như case 10 | Cancel request | **Xóa row** | #ch1: CANCELED |
| 12 | User đang BANNED workspace | Unban #chA, join lại #ch1 | Update `BANNED` → `PENDING_REQUEST` | #chA: ACTIVE, #ch1: PENDING_REQUEST |
| 13 | Admin gửi invite | User accept | Tạo `ACTIVE` (chưa từng) | #ch1: ACTIVE |
| 14 | Admin gửi invite | User reject | **Xóa row** | #ch1: LEFT |
| 15 | Admin gửi invite | Admin revoke | **Xóa row** | #ch1: LEFT |
| 16 | User có #chA ACTIVE | Bị kick #chA | Update → `BANNED` (giữ row) | #chA: BANNED |

---

## 9. Migration notes

### 9.1 Đã chạy

- `20260929_add_member_status_pending`: thêm `pending_request`, `pending_invite` vào `member_status`.
- `20260929_replace_muted_with_canceled`: thay `muted` bằng `canceled`.

### 9.2 Cần làm khi implement

1. **Refactor `requestJoinChannel` / `cancelJoinRequest` hiện tại**: 
   - Bỏ logic tạo/update workspaceMember thủ công trong `requestJoinChannel`.
   - Dùng helper `syncWorkspaceMember` ở cuối transaction.
   - Sửa `cancelJoinRequest` đổi từ `delete row` → `update status = CANCELED`.

2. **Thêm các method mới**: `acceptInvite`, `rejectInvite`, `revokeInvite`, `approveJoinRequest`, `rejectJoinRequest`, `leaveChannel`, `kickFromChannel`, `unbanFromChannel`, `inviteUserToChannel`.

3. **Tạo helper `syncWorkspaceMember`** trong `channel.services.ts` (hoặc tách module riêng).

4. **Test**: Chạy hết 16 test case ở §8.

5. **Backfill data** (optional): Nếu data cũ có `workspaceMember.status = LEFT`/`PENDING_REQUEST` không khớp với channelMember → chạy script đồng bộ lại bằng cách gọi helper cho từng (workspaceId, userId).
