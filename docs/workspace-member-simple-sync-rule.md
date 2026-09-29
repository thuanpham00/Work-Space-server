# WorkspaceMember Simple Sync Rule

> Rule đồng bộ giữa `workspaceMember.status` và tập `channelMember.status` của user trong cùng workspace. **Phiên bản đơn giản** — chỉ 1 invariant, 2 case, ~10 dòng helper.

Thay thế cho file `channel-workspace-member-sync-rule.md` cũ (đã deprecated).

---

## 1. Bối cảnh

### Tại sao vẫn cần `workspaceMember`?

Mặc dù đã có `channelMember`, vẫn cần `workspaceMember` vì **socket dùng nó để join workspace room**:

```ts
// src/socket/socket.ts
const workspaceMembers = await prisma.workspaceMember.findMany({
  where: { userId },
  select: { workspaceId: true }
})
for (const member of workspaceMembers) {
  socket.join(Socket_Room.workspace(member.workspaceId.toString()))
}
```

→ Cần biết **user nào thuộc workspace nào** để join room real-time.

### Tại sao không derive trực tiếp từ channelMember?

Vì performance. Khi user connect socket, phải biết ngay tất cả workspace user đó thuộc về. Nếu derive từ `channelMember`, phải query join `channel` → chậm. `workspaceMember` là bảng phẳng `(workspaceId, userId)` → query nhanh hơn nhiều.

### Vấn đề cần sync

`workspaceMember` và `channelMember` là 2 bảng độc lập. Khi một bên đổi → bên kia có thể stale → bug.

**Giải pháp**: 1 invariant duy nhất, helper đơn giản, gọi sau mỗi flow thay đổi `channelMember`.

---

## 2. Invariant duy nhất

> **`workspaceMember` tồn tại với `status = ACTIVE` ⟺ user có ít nhất 1 `channelMember` ACTIVE trong workspace đó.**

Nói cách khác:

- User có channel ACTIVE trong workspace → **phải có** row `workspaceMember` (status = ACTIVE)
- User không có channel ACTIVE nào → **không có** row `workspaceMember` (row bị xóa hoặc chưa từng tạo)

### Quy tắc áp dụng

| Channel ACTIVE? | workspaceMember row? | workspaceMember.status |
|---|---|---|
| Có | Có | ACTIVE |
| Có | Không có | (sẽ được tạo bởi helper) |
| Không | Không có | (không tạo) |
| Không | Có | (sẽ bị xóa bởi helper) |

→ **CHỈ 2 case**: có ACTIVE hoặc không có. Không có LEFT, không có PENDING_REQUEST, không có BANNED trong workspaceMember.

### Tại sao bỏ LEFT?

- File doc cũ giữ `LEFT` cho audit trail. Đánh đổi: phức tạp rule + 6 case transition.
- Plan này: **bỏ audit trail** → đổi lấy logic cực đơn giản. Nếu cần audit, query từ `channelMember` (có status LEFT).

### Tại sao bỏ PENDING_REQUEST trong workspaceMember?

- `PENDING_REQUEST` chỉ có ý nghĩa ở **channel** (user đang chờ duyệt vào channel cụ thể).
- Ở **workspace** level, "đang chờ duyệt" không có ý nghĩa rõ ràng — user chỉ vào được workspace khi được approve ít nhất 1 channel.
- → Sync xảy ra **sau khi approve**, không sync ở trạng thái pending.

### Tại sao bỏ BANNED?

- `BANNED` ở channelMember là "bị cấm vào channel đó". User có thể vẫn ACTIVE ở channel khác trong cùng workspace.
- Ở workspace level: nếu user bị ban hết channel → `n_active = 0` → workspaceMember tự động bị xóa. Đúng semantics.

### Role OWNER

- `workspaceMember.role = OWNER` **không tồn tại** — không tạo row cho OWNER.
- OWNER dùng `workspace.ownerId` (FK trong bảng `Workspace`) làm nguồn duyền duy nhất.
- Lợi ích: không có duplicate data, không phải sync khi đổi OWNER.

---

## 3. Helper function

```ts
/**
 * Đồng bộ workspaceMember dựa trên channelMember ACTIVE của user trong workspace.
 * - Nếu user có ≥1 channel ACTIVE → tạo/cập nhật workspaceMember với status = ACTIVE
 * - Nếu không → xóa workspaceMember (nếu có)
 *
 * Phải gọi trong transaction (truyền `tx`).
 */
async function syncWorkspaceMember(
  tx: Prisma.TransactionClient,
  workspaceId: bigint,
  userId: bigint
): Promise<void> {
  // Đếm channel ACTIVE
  const activeCount = await tx.channelMember.count({
    where: {
      userId,
      status: MemberStatus.ACTIVE,
      channel: { workspaceId }
    }
  })

  const existing = await tx.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } }
  })

  // Case 1: có channel ACTIVE → đảm bảo workspaceMember ACTIVE
  if (activeCount > 0) {
    if (existing) {
      if (existing.status !== MemberStatus.ACTIVE) {
        await tx.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId } },
          data: { status: MemberStatus.ACTIVE }
        })
      }
    } else {
      await tx.workspaceMember.create({
        data: {
          workspaceId,
          userId,
          role: WorkspaceMemberRole.MEMBER,
          status: MemberStatus.ACTIVE,
          joinedAt: new Date()
        }
      })
    }
    return
  }

  // Case 2: không còn channel ACTIVE → xóa workspaceMember (nếu có)
  if (existing) {
    await tx.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId } }
    })
  }
}
```

**~30 dòng, 2 case, không câu hỏi nào cần trả lời.**

---

## 4. Áp dụng vào service hiện tại

### 4.1 `requestJoinChannel(channelId, userId)`

**Hành vi**: User gửi request join channel. Tạo `channelMember` với `status = PENDING_REQUEST`.

**KHÔNG gọi helper** vì: user chưa ACTIVE channel → `activeCount = 0` → helper sẽ xóa row `workspaceMember` (đang ACTIVE) hoặc không tạo.

**Logic**:
```ts
async requestJoinChannel(channelId, userId) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true, name: true }
    })

    if (!channel) throw new NotFoundError('Channel không tồn tại')
    if (!channel.workspaceId) throw new BadRequestError('Channel DM không thể request')

    const existing = await tx.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })

    if (existing) {
      if (existing.status === PENDING_REQUEST) {
        throw new BadRequestError('Bạn đã gửi request trước đó')
      }
      if (existing.status === ACTIVE) {
        throw new BadRequestError('Bạn đã là thành viên')
      }
      // status = LEFT / BANNED → update lại
      await tx.channelMember.update({
        where: { channelId_userId: { channelId, userId } },
        data: { status: PENDING_REQUEST }
      })
    } else {
      await tx.channelMember.create({
        data: {
          channelId,
          userId,
          role: MEMBER,
          status: PENDING_REQUEST
        }
      })
    }

    // KHÔNG gọi syncWorkspaceMember vì chưa ACTIVE
    return { channelId, channelName: channel.name }
  })
}
```

### 4.2 `cancelJoinRequest(channelId, userId)`

**Hành vi**: User hủy request đang pending. Xóa `channelMember` PENDING_REQUEST.

**Có thể gọi helper** — nhưng vì user chưa ACTIVE → `activeCount = 0` → helper không làm gì.

**Logic**:
```ts
async cancelJoinRequest(channelId, userId) {
  return await prisma.$transaction(async (tx) => {
    const member = await tx.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    })

    if (!member) throw new NotFoundError('Request không tồn tại')
    if (member.status !== PENDING_REQUEST) {
      throw new BadRequestError('Chỉ hủy được request đang pending')
    }

    await tx.channelMember.delete({
      where: { channelId_userId: { channelId, userId } }
    })

    // Gọi helper cho an toàn (no-op trong case này)
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true }
    })
    if (channel?.workspaceId) {
      await syncWorkspaceMember(tx, channel.workspaceId, userId)
    }

    return { channelId }
  })
}
```

### 4.3 `approveJoinRequest(channelId, userId)` — flow mới

**Hành vi**: Admin duyệt request. Update `channelMember` từ PENDING_REQUEST → ACTIVE.

**BẮT BUỘC gọi helper** — vì lần đầu user ACTIVE channel trong workspace → `activeCount` vừa tăng từ 0 lên >0 → cần tạo workspaceMember.

**Logic**:
```ts
async approveJoinRequest(channelId, userId) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true }
    })
    if (!channel?.workspaceId) throw new BadRequestError('Channel không hợp lệ')

    // Update channelMember
    await tx.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { status: ACTIVE, joinedAt: new Date() }
    })

    // BẮT BUỘC gọi helper
    await syncWorkspaceMember(tx, channel.workspaceId, userId)

    return { channelId, userId }
  })
}
```

### 4.4 `rejectJoinRequest(channelId, userId)` — flow mới

**Hành vi**: Admin từ chối. Xóa `channelMember` PENDING_REQUEST.

**Gọi helper cho an toàn** — no-op vì user chưa ACTIVE.

**Logic**:
```ts
async rejectJoinRequest(channelId, userId) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true }
    })
    if (!channel?.workspaceId) throw new BadRequestError('Channel không hợp lệ')

    await tx.channelMember.delete({
      where: { channelId_userId: { channelId, userId } }
    })

    await syncWorkspaceMember(tx, channel.workspaceId, userId)

    return { channelId, userId }
  })
}
```

### 4.5 `leaveChannel(channelId, userId)` — flow mới

**Hành vi**: User rời channel ACTIVE. Update `channelMember` ACTIVE → LEFT.

**BẮT BUỘC gọi helper** — nếu đây là channel ACTIVE cuối cùng của user trong workspace → `activeCount` vừa giảm về 0 → cần xóa workspaceMember.

**Logic**:
```ts
async leaveChannel(channelId, userId) {
  return await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findUnique({
      where: { id: channelId },
      select: { workspaceId: true }
    })
    if (!channel?.workspaceId) throw new BadRequestError('Channel không hợp lệ')

    await tx.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { status: LEFT }
    })

    // BẮT BUỘC gọi helper
    await syncWorkspaceMember(tx, channel.workspaceId, userId)

    return { channelId }
  })
}
```

### 4.6 `kickFromChannel(channelId, userId, kickedBy)` — flow mới

**Hành vi**: Admin kick user. Update `channelMember` ACTIVE → BANNED.

**BẮT BUỘC gọi helper** — tương tự leave.

**Logic**: tương tự `leaveChannel`, status BANNED thay vì LEFT.

### 4.7 `acceptInvite(channelId, userId)` — flow invite link

**Hành vi**: User accept invite link → vào channel ACTIVE luôn (không qua pending).

**BẮT BUỘC gọi helper** — tạo channelMember ACTIVE → có thể tạo workspaceMember.

**Logic**: tương tự `approveJoinRequest`.

---

## 5. Bảng transition

| Flow | channelMember.status trước | channelMember.status sau | activeCount | workspaceMember sau |
|---|---|---|---|---|
| **Request join #ch1** (chưa ACTIVE ws) | (không có) | PENDING_REQUEST | 0 | (không tạo) |
| **Cancel request #ch1** | PENDING_REQUEST | (xóa) | 0 | (không tạo) |
| **Approve #ch1** | PENDING_REQUEST | ACTIVE | 0→1 | Tạo mới ACTIVE |
| **Reject #ch1** | PENDING_REQUEST | (xóa) | 0 | (không tạo) |
| **Leave #ch1** (còn #ch2 ACTIVE) | ACTIVE | LEFT | 2→1 | Giữ ACTIVE |
| **Leave #ch1** (channel ACTIVE cuối) | ACTIVE | LEFT | 1→0 | Xóa |
| **Bị kick #ch1** (còn #ch2 ACTIVE) | ACTIVE | BANNED | 2→1 | Giữ ACTIVE |
| **Bị kick #ch1** (channel ACTIVE cuối) | ACTIVE | BANNED | 1→0 | Xóa |
| **Accept invite #ch1** (chưa ACTIVE ws) | (không có) | ACTIVE | 0→1 | Tạo mới ACTIVE |

---

## 6. Lợi ích so với rule cũ

| Tiêu chí | Rule cũ | Rule mới |
|---|---|---|
| Số status | 5 (ACTIVE/PENDING/LEFT/BANNED/MUTED) | 1 (ACTIVE) |
| Số invariant | 1 phức tạp (derive từ 5 count) | 1 đơn giản (count > 0) |
| Số case transition | 6+ | 2 |
| Helper | 60 dòng | 30 dòng |
| Audit trail | Có (giữ LEFT) | Không |
| Câu hỏi cần trả lời | 3+ (threshold, helper ở đâu, ...) | 0 |
| Performance | OK (count 1 bảng) | Tốt hơn (count 1 bảng, 2 case) |
| Khả năng bug sync | Trung bình | Rất thấp |

---

## 7. Câu hỏi cần confirm trước khi implement

1. **Đặt helper ở đâu?**
   - Option A: Private method trong `ChannelService` (gọi qua `this`)
   - Option B: Static function trong `channel.services.ts`
   - Option C: Tách ra `workspaceMember.services.ts` riêng

2. **Có cần update file `backfill-owner-workspace-members.ts` không?**
   - Vì plan mới **không tạo workspaceMember cho OWNER** (dùng `workspace.ownerId`)
   - File này có còn cần thiết không?

3. **Helper có nên throw error nếu `activeCount` thay đổi giữa 2 query không?**
   - Hiện không có concurrency control — nếu 2 transaction cùng đụng 1 user, có thể race condition.
   - Trade-off: thêm `SERIALIZABLE` isolation → chậm hơn. Chấp nhận race condition nhỏ?

4. **Có cần test case cho scenario 1 user có 100 channel ACTIVE?**
   - Performance: query count 100 channel có chậm không?
   - Có nên thêm index `(userId, status, channel.workspaceId)` không?

---

## 8. Test case cần cover

| # | Setup | Action | Expected workspaceMember | Expected channelMember |
|---|---|---|---|---|
| 1 | User mới, chưa có gì | Request join #ch1 | (không tạo) | #ch1: PENDING_REQUEST |
| 2 | Như case 1 | Cancel request | (không có) | #ch1: deleted |
| 3 | User mới | Approve request #ch1 | Tạo mới ACTIVE | #ch1: ACTIVE |
| 4 | User có #chA ACTIVE | Request join #ch1 | Giữ ACTIVE | #ch1: PENDING_REQUEST, #chA: ACTIVE |
| 5 | Như case 4 | Cancel request | Giữ ACTIVE | #ch1: deleted, #chA: ACTIVE |
| 6 | User có #chA ACTIVE | Approve request #ch1 | Giữ ACTIVE (không đổi) | #ch1: ACTIVE, #chA: ACTIVE |
| 7 | User có #chA ACTIVE | Leave #chA | Xóa (vì không còn channel nào ACTIVE) | #chA: LEFT |
| 8 | User có #chA, #chB ACTIVE | Leave #chA | Giữ ACTIVE | #chA: LEFT, #chB: ACTIVE |
| 9 | User có #chA ACTIVE | Bị kick #chA | Xóa | #chA: BANNED |
| 10 | User bị BANNED ở #chA, ACTIVE ở #chB | Leave #chB | Xóa | #chA: BANNED, #chB: LEFT |
| 11 | OWNER tạo workspace | (không có channelMember) | (không tạo - dùng workspace.ownerId) | (không có) |

---

## 9. Migration notes (nếu áp dụng rule mới)

### Cho data hiện tại

Nếu database hiện đang có workspaceMember với status LEFT/PENDING_REQUEST/BANNED:

**Option A: Bỏ qua** — chỉ áp rule mới cho flow mới. Data cũ vẫn LEFT/PENDING cho đến khi user tương tác lại.

**Option B: Chạy migration script** — xóa hết workspaceMember không ACTIVE. User sẽ tự động được tạo lại khi join channel.

**Recommendation**: Option A (an toàn). Sau 1 thời gian, chạy Option B khi cần dọn dẹp.

### Cho code hiện tại

- Xóa toàn bộ logic đụng `workspaceMember` trong `requestJoinChannel` và `cancelJoinRequest`
- Thêm helper `syncWorkspaceMember` ở đầu file (hoặc tách module)
- Implement 5 flow mới: approve, reject, leave, kick, accept invite (chưa có)
