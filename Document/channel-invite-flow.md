# Luồng Xử Lý: Mời Thành Viên & Quản Lý Channel

> Tài liệu thiết kế UX và logic nghiệp vụ cho hệ thống Workspace Channel

---

## 1. Tổng Quan Kiến Trúc

### 1.1 Hai Loại Channel

| Loại | `isPrivate` | Mô tả |
|------|-------------|--------|
| **Public** | `false` | Ai trong workspace cũng thấy |
| **Private** | `true` | Chỉ thành viên được mời mới thấy |

### 1.2 Flag `isDefault` (Chỉ áp dụng Public)

| `isPrivate` | `isDefault` | Ý nghĩa |
|-------------|-------------|---------|
| `false` | `true` | Auto-join khi user vào workspace |
| `false` | `false` | User tự browse và join |
| `true` | `false` (forced) | Phải được mời mới vào |

---

## 2. Luồng Khi Mời User Vào Workspace

```
┌─────────────────────────────────────────────────────────────────┐
│                    MỜI USER VÀO WORKSPACE                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Bước 1: Thêm user vào workspace members                        │
│          POST /api/workspaces/:id/members                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Bước 2: Lấy danh sách channel cần auto-join                     │
│          GET /api/channels?workspaceId=xxx&isDefault=true       │
│                                                                  │
│          → Filter: isPrivate = false AND isDefault = true       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Bước 3: Auto-join các channel đó                                │
│          POST /api/channels/:channelId/members                   │
│          (Lặp qua tất cả channel default)                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                         ✅ Hoàn tất
```

### Kết quả:

- ✅ User được thêm vào workspace
- ✅ User tự động join các **channel public có `isDefault = true`**
- ❌ User **không** được join các channel private
- ❌ User **không** được join các channel public có `isDefault = false`

---

## 3. Luồng Mời User Vào Channel (Cụ Thể)

### 3.1 Channel Public

```
┌─────────────────────────────────────────────────────────────────┐
│                 MỜI USER VÀO CHANNEL PUBLIC                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Ai có quyền mời?                                                 │
│   ├── Workspace Admin → ✅ Có quyền                              │
│   ├── Channel Admin → ✅ Có quyền                                │
│   └── Member thường → ❌ Không có quyền                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Modal: Tìm kiếm user để mời                                      │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 🔍 Search: [________________]                              │  │
│ │                                                            │  │
│ │ Kết quả tìm kiếm:                                         │  │
│ │   ☑ Nguyễn Văn A (nguyenvana@email.com)                   │  │
│ │   ☐ Trần Thị B (tranthib@email.com)                       │  │
│ │                                                            │  │
│ │                              [Hủy]  [Mời 1 người]          │  │
│ └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Gọi API: POST /api/channels/:channelId/members                  │
│ Body: { userIds: ["user-a-id"] }                                │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Channel Private

```
┌─────────────────────────────────────────────────────────────────┐
│                MỜI USER VÀO CHANNEL PRIVATE                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Ai có quyền mời?                                                 │
│   ├── Workspace Admin → ✅ Có quyền                              │
│   ├── Channel Admin → ✅ Có quyền                                │
│   └── Member thường → ❌ Không có quyền                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Modal: Tìm kiếm user để mời (Giống public)                      │
│                                                                  │
│ ⚠️ Lưu ý: User được mời sẽ THẤY channel này lần đầu            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Gọi API: POST /api/channels/:channelId/members                   │
│ Body: { userIds: ["user-a-id"] }                                │
│                                                                  │
│ Backend xử lý:                                                   │
│   1. Thêm user vào channel members                              │
│   2. Gửi notification cho user được mời                        │
│   3. User thấy channel trong danh sách                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Luồng Tạo Channel Mới

```
┌─────────────────────────────────────────────────────────────────┐
│                      TẠO CHANNEL MỚI                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Modal Tạo Channel                                                 │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Tên: [____________________]                                 │  │
│ │ Mô tả: [____________________]                              │  │
│ │ Loại:  ○ Public  ● Private                                  │  │
│ │                                                            │  │
│ │ ☐ Kênh riêng tư                                           │  │
│ │                                                            │  │
│ │ Auto-join khi vào workspace:                               │  │
│ │ [  ] ☑ Enable                                              │  │
│ │     (Chỉ áp dụng với channel public)                       │  │
│ │                                                            │  │
│ │              [Hủy]  [Tạo Channel]                          │  │
│ └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Validation Logic:

```
┌─────────────────────────────────────────────────────────────────┐
│ Validation khi submit                                             │
└─────────────────────────────────────────────────────────────────┘

if (isPrivate === true) {
    isDefault = false;  // ← Force không cho phép default
    // Hoặc disable checkbox trong UI
}

if (isPrivate === false && isDefault === true) {
    // ✅ Hợp lệ - Channel public và auto-join
}

if (isPrivate === false && isDefault === false) {
    // ✅ Hợp lệ - Channel public nhưng user tự join
}
```

---

## 5. Luồng User Rời Khỏi Channel

### 5.1 Channel Public

```
┌─────────────────────────────────────────────────────────────────┐
│               USER RỜI CHANNEL PUBLIC                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ User có thể tự rời channel public                                │
│   └── Channel vẫn còn trong workspace                           │
│   └── User có thể join lại bất cứ lúc nào                       │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 Channel Private

```
┌─────────────────────────────────────────────────────────────────┐
│              USER RỜI CHANNEL PRIVATE                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Tùy chính sách workspace:                                        │
│                                                                  │
│ Option A: User được tự rời                                       │
│   └── Phải được mời lại nếu muốn quay lại                       │
│                                                                  │
│ Option B: Không cho rời (Admin set)                              │
│   └── Thông báo: "Bạn không thể rời channel này"                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Bảng Quyền Tổng Hợp

| Action | Workspace Admin | Channel Admin | Member |
|--------|-----------------|---------------|--------|
| Tạo channel public | ✅ | ❌ | ❌ |
| Tạo channel private | ✅ | ❌ | ❌ |
| Mời vào channel public | ✅ | ✅ | ❌ |
| Mời vào channel private | ✅ | ✅ | ❌ |
| Xóa thành viên khỏi channel | ✅ | ✅ | ❌ |
| Rời channel public | ✅ | ✅ | ✅ |
| Rời channel private | ✅ | ✅ | Tùy setting |
| Chỉnh sửa channel | ✅ | ✅ (chỉ info) | ❌ |
| Xóa channel | ✅ | ❌ | ❌ |

---

## 7. API Endpoints

### 7.1 Workspace

```typescript
// Mời user vào workspace
POST /api/workspaces/:workspaceId/members
Body: { email: string, role?: 'ADMIN' | 'MEMBER' }
Response: { userId: string, workspaceId: string }

// Backend tự động:
// 1. Thêm user vào workspace
// 2. Auto-join các channel: isPrivate=false AND isDefault=true
```

### 7.2 Channel

```typescript
// Tạo channel mới
POST /api/workspaces/:workspaceId/channels
Body: {
  name: string,
  description?: string,
  isPrivate: boolean,
  isDefault?: boolean  // Chỉ dùng khi isPrivate=false
}

// Lấy channel default để auto-join
GET /api/workspaces/:workspaceId/channels?isDefault=true&isPrivate=false

// Mời user vào channel
POST /api/channels/:channelId/members
Body: { userIds: string[] }

// Lấy danh sách user có thể mời
GET /api/channels/:channelId/available-members?search=xxx
Response: { users: User[] }
```

---

## 8. Database Schema (Tham khảo)

```sql
CREATE TABLE channels (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    type VARCHAR(50) DEFAULT 'text',
    is_private BOOLEAN DEFAULT FALSE,
    is_default BOOLEAN DEFAULT FALSE,  -- Chỉ dùng khi is_private=false
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    CONSTRAINT chk_default_private CHECK (
        NOT (is_private = TRUE AND is_default = TRUE)
        -- Không cho phép is_private=true AND is_default=true
    )
);

CREATE TABLE channel_members (
    channel_id UUID REFERENCES channels(id),
    user_id UUID REFERENCES users(id),
    role VARCHAR(20) DEFAULT 'MEMBER',  -- ADMIN, MEMBER
    joined_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE workspace_members (
    workspace_id UUID REFERENCES workspaces(id),
    user_id UUID REFERENCES users(id),
    role VARCHAR(20) DEFAULT 'MEMBER',
    joined_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);
```

---

## 9. Flow Chart Tổng Hợp

```
                        ┌─────────────────────┐
                        │  User được mời       │
                        │  vào Workspace       │
                        └──────────┬──────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │  Auto-join các channel có:    │
                    │  isPrivate = FALSE           │
                    │  AND isDefault = TRUE        │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────┴───────────────┐
                    │                              │
                    ▼                              ▼
           ┌─────────────────┐          ┌─────────────────┐
           │  Thấy channel   │          │ Không thấy      │
           │  #general       │          │ channel #secret  │
           │  #announcements │          │ (private)        │
           │  #marketing     │          │                  │
           └────────┬────────┘          └─────────────────┘
                    │
                    ▼
        ┌───────────────────────────────┐
        │ Muốn vào #marketing           │
        │ (public, isDefault=false)     │
        └───────────────┬───────────────┘
                        │
                        ▼
              ┌─────────────────┐
              │ Browse & Join   │
              │ Click "Join"    │
              └─────────────────┘
                        │
                        ▼
              ┌─────────────────┐
              │ Thành viên mới  │
              │ của #marketing  │
              └─────────────────┘
```

---

## 10. Checklist Triển Khai

### Backend
- [ ] Thêm column `is_default` vào bảng channels
- [ ] Thêm validation: `is_private=true` → `is_default` phải = `false`
- [ ] API tạo channel: hỗ trợ param `is_default`
- [ ] Logic auto-join khi add user vào workspace
- [ ] API mời user vào channel (public/private)
- [ ] API lấy danh sách user có thể mời

### Frontend
- [ ] Update `types/channel.type.ts` thêm `isDefault`
- [ ] Update `ChannelModal.tsx` thêm checkbox `isDefault`
- [ ] Disable checkbox `isDefault` khi `isPrivate=true`
- [ ] Update `MemberChannel.tsx` - mở modal mời thành viên
- [ ] Tạo component `ModalInviteMember.tsx`
- [ ] Update UI hiển thị channel default trong sidebar

---

## 11. Q&A

**Q: Nếu một channel public đổi từ `isDefault=true` sang `isDefault=false` thì sao?**
A: User đã join trước đó vẫn ở trong channel. Chỉ user mới vào workspace mới không auto-join.

**Q: User có thể rời channel default không?**
A: Có, `isDefault` chỉ ảnh hưởng đến auto-join, không khóa user lại.

**Q: Channel private có `isDefault` được không?**
A: Không, validation không cho phép. UI sẽ disable checkbox.

**Q: Workspace admin có quyền gì đặc biệt?**
A: Có thể tạo/xóa channel, mời user vào bất kỳ channel nào, quản lý workspace settings.

---

*Document version: 1.0*
*Last updated: 2026-09-10*
