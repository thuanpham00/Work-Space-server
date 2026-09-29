# Channel WorkspaceMember Sync Rule

> File mô tả rule đồng bộ giữa `WorkspaceMember.status` và tập `ChannelMember.status` của user trong cùng workspace. Áp dụng cho các flow: request join, cancel request, approve, reject, leave channel, kick, ...

---

## 1. Bối cảnh & vấn đề

Hiện tại có 2 bảng liên quan đến quyền user trong workspace:

- **`WorkspaceMember`**: đại diện cho user thuộc về workspace nào, có `status` riêng.
- **`ChannelMember`**: đại diện cho user thuộc về channel nào, có `status` riêng.

**Câu hỏi**: Khi một trong hai bảng đổi trạng thái, bảng còn lại có nên / phải đổi theo không? Nếu có thì theo rule nào?

### Ví dụ cụ thể gây bug nếu không sync

- User A đã ACTIVE workspace qua channel #general.
- User A gửi request join channel #private-public → `channelMember.status = PENDING_REQUEST`.
- Nếu `workspaceMember.status` KHÔNG đổi → vẫn ACTIVE → hợp lý (user vẫn truy cập workspace bình thường).
- Nhưng nếu user A **chưa từng ACTIVE** workspace (mới join lần đầu qua request) → `workspaceMember` được tạo mới → nên là gì? `ACTIVE` hay `PENDING_REQUEST`?

→ Cần định nghĩa rõ invariant.

---

## 2. Invariant (quy tắc bất biến)

> **`workspaceMember.status` được derive từ trạng thái của tất cả `channelMember` của user đó trong workspace.**

Cụ thể:

```
n_active    = count(channelMember của user trong workspace, status = ACTIVE)
n_pending   = count(channelMember của user trong workspace, status IN [PENDING_REQUEST, PENDING_INVITE])
n_canceled  = count(channelMember của user trong workspace, status = CANCELED)
n_left      = count(channelMember của user trong workspace, status = LEFT)
n_banned    = count(channelMember của user trong workspace, status = BANNED)

if n_active > 0:
    workspaceMember.status = ACTIVE
elif n_pending > 0:
    workspaceMember.status = PENDING_REQUEST  (hoặc PENDING_INVITE nếu chỉ có invite)
elif n_banned > 0:
    workspaceMember.status = BANNED
else:
    workspaceMember.status = LEFT
```

### Lưu ý đặc biệt

1. **CANCELED** là terminal state cho user đã gửi `PENDING_REQUEST` rồi hủy (cancel) — chỉ là flag của từng channel, không ảnh hưởng `workspaceMember.status`.
2. **Khi user từng ACTIVE workspace rồi rời hết channels** → `workspaceMember.status = LEFT`, không xóa row (giữ audit).
3. **Khi user chưa từng ACTIVE workspace** (request lần đầu) → `workspaceMember` được tạo với `status = PENDING_REQUEST`. Sau khi cancel request, nếu không còn channel nào pending → **xóa luôn row** `workspaceMember` (vì row này sinh ra chỉ vì request này).

---

## 3. Bảng transition rule cho `workspaceMember.status`

| Trigger | Điều kiện | Action trên workspaceMember |
|---|---|---|
| **Request join channel mới** (chưa có channelMember nào của user trong workspace) | `n_active = 0`, `n_pending = 0` | **Tạo mới** với `status = PENDING_REQUEST` |
| **Request join channel mới** (đã có workspaceMember) | `n_active > 0` | Update `status = PENDING_REQUEST` |
| **Request join channel mới** (đã có workspaceMember) | `n_active = 0`, `n_pending > 0` | Giữ nguyên `PENDING_REQUEST` |
| **Cancel request join** (xóa channelMember PENDING_REQUEST) | Sau khi xóa, `n_pending = 0` và `n_active = 0` | **Xóa** workspaceMember (nếu nó vừa được tạo) hoặc **revert LEFT** (nếu từng ACTIVE trước) |
| **Cancel request join** (xóa channelMember PENDING_REQUEST) | Sau khi xóa, vẫn còn `n_pending > 0` | Giữ nguyên `PENDING_REQUEST` |
| **Approve request** | channelMember PENDING → ACTIVE | `workspaceMember.status = ACTIVE` (vì `n_active` vừa tăng) |
| **Reject request** | xóa channelMember PENDING | Re-evaluate theo rule §2 |
| **Leave channel ACTIVE** | channelMember ACTIVE → LEFT | Nếu user rời channel ACTIVE cuối cùng → `workspaceMember.status = LEFT` (giữ audit) |
| **Bị kick khỏi channel ACTIVE** | channelMember ACTIVE → BANNED | Tương tự leave |

---

## 4. Helper function

Để áp dụng rule trên nhất quán, đề xuất tạo helper:

```ts
/**
 * Re-evaluate workspaceMember.status dựa trên trạng thái tất cả channelMember của user trong workspace.
 * - Nếu chưa có workspaceMember và user chưa từng thuộc workspace → tạo mới với PENDING_REQUEST.
 * - Nếu workspaceMember đang PENDING_REQUEST và không còn channel pending nào + chưa từng ACTIVE → xóa.
 * - Ngược lại update status theo rule §2.
 *
 * Phải gọi trong transaction (truyền `tx`).
 */
async function recalculateWorkspaceMemberStatus(
  tx: Prisma.TransactionClient,
  workspaceId: bigint,
  userId: bigint
): Promise<void>
```

### Logic helper (pseudo-code)

```ts
async function recalculateWorkspaceMemberStatus(tx, workspaceId, userId) {
  // 1. Đếm channelMember theo status
  const [nActive, nPending] = await Promise.all([
    tx.channelMember.count({
      where: {
        userId,
        status: ACTIVE,
        channel: { workspaceId }   // join qua channel.workspaceId
      }
    }),
    tx.channelMember.count({
      where: {
        userId,
        status: { in: [PENDING_REQUEST, PENDING_INVITE] },
        channel: { workspaceId }
      }
    })
  ])

  // 2. Lookup workspaceMember hiện tại
  const wsMember = await tx.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } }
  })

  // 3. Tính status mới
  let newStatus: MemberStatus
  if (nActive > 0) newStatus = ACTIVE
  else if (nPending > 0) newStatus = PENDING_REQUEST
  else newStatus = LEFT

  // 4. Áp dụng
  if (!wsMember) {
    // Chưa có → tạo mới (chỉ xảy ra ở request join đầu tiên)
    if (newStatus !== LEFT) {  // không tạo nếu không cần thiết
      await tx.workspaceMember.create({
        data: {
          workspaceId, userId,
          role: MEMBER,
          status: newStatus,
          joinedAt: new Date()
        }
      })
    }
    return
  }

  // 5. Nếu đang PENDING_REQUEST và không còn pending + chưa từng ACTIVE → xóa
  if (wsMember.status === PENDING_REQUEST && nActive === 0 && nPending === 0) {
    // Check xem user đã từng ACTIVE workspace chưa (audit trail)
    // Nếu joinedAt + 1 ngày < now (mới tạo gần đây) → xóa
    // Ngược lại → revert LEFT
    const isRecentlyCreated = Date.now() - wsMember.joinedAt.getTime() < 60_000  // 1 phút
    if (isRecentlyCreated) {
      await tx.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId, userId } }
      })
    } else {
      await tx.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { status: LEFT }
      })
    }
    return
  }

  // 6. Update nếu status thay đổi
  if (wsMember.status !== newStatus) {
    await tx.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: { status: newStatus }
    })
  }
}
```

---

## 5. Refactor 2 service hiện tại

### 5.1 `requestJoinChannel(channelId, userId)`

**Hiện tại**: hard-code `workspaceMember.status = PENDING_REQUEST`, có case xử lý riêng cho "đã có workspaceMember" vs "chưa có".

**Refactor**: Sau khi upsert `channelMember` với `PENDING_REQUEST` → gọi `recalculateWorkspaceMemberStatus(tx, workspaceId, userId)`.

→ Helper sẽ tự quyết định tạo mới / update / giữ nguyên.

### 5.2 `cancelJoinRequest(channelId, userId)`

**Hiện tại**: chỉ xóa `channelMember`, KHÔNG đụng `workspaceMember` → gây zombie data.

**Refactor**: Trong transaction:
1. Lookup channel + workspaceId (cần cho helper).
2. Validate channelMember tồn tại & đang PENDING_REQUEST (giữ logic cũ).
3. Xóa channelMember.
4. Gọi `recalculateWorkspaceMemberStatus(tx, workspaceId, userId)`.

→ Helper sẽ tự quyết định xóa workspaceMember / revert LEFT / giữ nguyên.

---

## 6. Lợi ích

1. **Single source of truth**: Chỉ cần nhớ rule §2, mọi flow đều dùng chung.
2. **Không bug downgrade**: User đang ACTIVE workspace không bao giờ bị hạ xuống LEFT khi cancel request (nếu còn channel ACTIVE khác).
3. **Không zombie data**: workspaceMember chỉ tồn tại khi thực sự cần.
4. **Audit trail**: User từng ACTIVE rồi rời hết → giữ LEFT, không xóa.
5. **Reusable**: Approve / reject / leave channel / kick đều dùng helper này.

---

## 7. Test case cần cover

| # | Setup | Action | Expected workspaceMember.status | Expected channelMember |
|---|---|---|---|---|
| 1 | User mới, chưa có gì | Request join #ch1 | `PENDING_REQUEST` (tạo mới) | #ch1: `PENDING_REQUEST` |
| 2 | Như case 1 | Cancel request | **xóa workspaceMember** | #ch1: deleted |
| 3 | User đã ACTIVE workspace (#chA), không có pending nào | Request join #ch1 | `PENDING_REQUEST` (update từ ACTIVE) | #ch1: `PENDING_REQUEST`, #chA: `ACTIVE` |
| 4 | Như case 3 | Cancel request | revert về `ACTIVE` | #ch1: deleted, #chA: `ACTIVE` |
| 5 | User đã LEFT workspace trước đó | Request join #ch1 | `PENDING_REQUEST` (update từ LEFT) | #ch1: `PENDING_REQUEST` |
| 6 | Như case 5 | Cancel request | revert về `LEFT` (giữ audit) | #ch1: deleted |
| 7 | User có 2 channels pending (#ch1, #ch2) | Cancel #ch1 | `PENDING_REQUEST` (giữ nguyên vì còn #ch2) | #ch1: deleted, #ch2: `PENDING_REQUEST` |

---

## 8. Câu hỏi cần confirm trước khi implement

1. **Threshold "recently created"** (mục 4.5): dùng `joinedAt + 1 phút` để quyết định xóa vs revert LEFT. Có hợp lý không? Hay nên dùng cơ chế khác (ví dụ: cờ `createdFromRequest: boolean`)?
2. **Khi revert LEFT**: có cần set `leftAt: new Date()` không? Hiện schema có trường này chưa?
3. **Có muốn helper là private method của `ChannelService` hay tách ra `WorkspaceMemberService` riêng?**
