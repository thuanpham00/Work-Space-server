# Thuật toán Search All — Merge Users + Workspaces

## 1. Bài toán

API `/searchs` cần trả về kết quả phân trang gộp từ **2 bảng khác nhau**: `users` và `workspaces`.

Ví dụ: trong DB có:
- 12 users match search "A"
- 8 workspaces match search "A"
- Tổng = 20 items

Yêu cầu:
- Mỗi page trả đúng `limit` items (10 chẳng hạn)
- Thứ tự ổn định giữa các page
- Tối ưu: DB chỉ trả đúng số items cần thiết, không trả thừa rồi bỏ

---

## 2. Quan sát quan trọng

Trong logic hiện tại, mảng merged luôn có dạng:

```
merged = [user_1, user_2, ..., user_N, workspace_1, workspace_2, ..., workspace_M]
        └── users đặt trước ─────────────────┘└── workspaces đặt sau ──────┘
```

Tức là: **tất cả users đứng trước, tất cả workspaces đứng sau**. Hai bảng không trộn lẫn.

Điều này cho phép ta biết chính xác tại vị trí `skip` trong merged array, ta đang ở trong phần users hay phần workspaces.

---

## 3. Ý tưởng thuật toán

Thay vì lấy thừa items rồi slice trong JS (chậm), ta tính toán trước khi query DB:

1. **Bước 1 — Đếm tổng**: `count()` cả 2 bảng → biết `totalUsers`, `totalWorkspaces`
2. **Bước 2 — Tính vị trí `skip` trong merged**: skip `0..totalUsers-1` nằm trong phần users, skip `totalUsers..total-1` nằm trong phần workspaces
3. **Bước 3 — Tính chính xác `skip` và `take` cho từng bảng**: dựa trên vị trí skip
4. **Bước 4 — Query song song 2 bảng** với skip/take chính xác
5. **Bước 5 — Merge kết quả**: `[users_taken] + [workspaces_taken]` đã đúng thứ tự, không cần slice

---

## 4. Công thức tính skip/take cho từng bảng

### Trường hợp A: `skip < totalUsers` (còn nằm trong phần users)

```
userSkip    = skip                                  // bỏ qua `skip` users đầu
userTake    = min(limit, totalUsers - skip)         // lấy tối đa `limit`, nhưng không vượt quá số user còn lại
workspaceSkip = 0                                   // chưa đụng tới workspaces
workspaceTake = limit - userTake                    // lấy phần còn thiếu cho đủ `limit`
```

### Trường hợp B: `skip >= totalUsers` (đã hết users, sang workspaces)

```
userSkip       = totalUsers                          // bỏ qua hết users
userTake       = 0                                   // không lấy user nào
workspaceSkip  = skip - totalUsers                   // bỏ qua phần workspaces đã dùng ở page trước
workspaceTake  = min(limit, totalWorkspaces - workspaceSkip)
```

### Code rút gọn (an toàn với mọi trường hợp):

```ts
const userSkip = Math.min(skip, totalUsers)
const userTake = Math.max(0, Math.min(limitNumber, totalUsers - userSkip))
const workspaceTakeNeeded = limitNumber - userTake
const workspaceSkip = Math.max(0, skip - totalUsers)
const workspaceTake = Math.max(0, Math.min(workspaceTakeNeeded, totalWorkspaces - workspaceSkip))
```

---

## 5. Ví dụ minh họa từng bước

### Setup

- `totalUsers = 12` (u1, u2, ..., u12)
- `totalWorkspaces = 8` (w1, w2, ..., w8)
- `total = 20`
- `limit = 10`

### Merged array (minh họa thứ tự)

```
Index:  0   1   2   3   4   5   6   7   8   9   10  11  12  13  14  15  16  17  18  19
Data:  u1  u2  u3  u4  u5  u6  u7  u8  u9  u10 u11 u12 w1  w2  w3  w4  w5  w6  w7  w8
       └──── phần users (12 items) ────────────────┘└──── phần workspaces (8 items) ────┘
```

### Page 1: `page=1, limit=10, skip=0`

Vì `skip=0 < totalUsers=12` → **Trường hợp A**

```ts
userSkip        = 0
userTake        = min(10, 12-0)  = 10
workspaceSkip   = 0
workspaceTake   = 10 - 10 = 0
```

Query:
```sql
SELECT * FROM users WHERE ... LIMIT 10 OFFSET 0;        -- → [u1..u10]
SELECT * FROM workspaces WHERE ... LIMIT 0;             -- → [] (bỏ qua)
```

Merged: `[u1, u2, u3, u4, u5, u6, u7, u8, u9, u10]` ✓ đúng 10 items

---

### Page 2: `page=2, limit=10, skip=10`

Vì `skip=10 < totalUsers=12` → **Trường hợp A** (vẫn còn 2 users cuối)

```ts
userSkip        = 10
userTake        = min(10, 12-10)  = 2                // chỉ còn 2 users
workspaceSkip   = 0
workspaceTake   = 10 - 2 = 8                          // lấy 8 workspaces bù vào
```

Query:
```sql
SELECT * FROM users WHERE ... LIMIT 2 OFFSET 10;       -- → [u11, u12]
SELECT * FROM workspaces WHERE ... LIMIT 8 OFFSET 0;   -- → [w1..w8]
```

Merged: `[u11, u12, w1, w2, w3, w4, w5, w6, w7, w8]` ✓ đúng 10 items

---

### Page 3: `page=3, limit=10, skip=20`

Vì `skip=20 >= totalUsers=12` → **Trường hợp B** (đã hết users)

```ts
userSkip        = min(20, 12) = 12
userTake        = max(0, min(10, 12-12))  = 0
workspaceSkip   = max(0, 20 - 12) = 8                  // đã dùng w1..w8 ở page 2
workspaceTake   = max(0, min(10, 8-8))  = 0           // hết workspaces
```

Query:
```sql
SELECT * FROM users WHERE ... LIMIT 0;                 -- → [] (bỏ qua)
SELECT * FROM workspaces WHERE ... LIMIT 0;            -- → [] (hết data)
```

Merged: `[]` ✓ trang rỗng, frontend sẽ ẩn nút "Xem thêm"

---

### Page vượt quá: `page=4, limit=10, skip=30`

```ts
userSkip        = min(30, 12) = 12
userTake        = 0
workspaceSkip   = max(0, 30 - 12) = 18                 // vượt quá totalWorkspaces
workspaceTake   = max(0, min(10, 8-18)) = 0
```

Cả 2 query đều trả `[]`. ✓

---

## 6. Bảng tổng hợp theo từng page

| Page | skip | userSkip | userTake | workspaceSkip | workspaceTake | Items trả về |
|------|------|----------|----------|---------------|---------------|--------------|
| 1 | 0 | 0 | 10 | 0 | 0 | u1..u10 |
| 2 | 10 | 10 | 2 | 0 | 8 | u11, u12, w1..w8 |
| 3 | 20 | 12 | 0 | 8 | 0 | [] |
| 4 | 30 | 12 | 0 | 18 | 0 | [] |

---

## 7. So sánh cách cũ vs cách mới

### Cách cũ (O(skip))

```ts
// Lấy thừa `skip + limit` items mỗi bảng, rồi slice trong JS
const users = await prisma.user.findMany({ skip: 0, take: skip + limit })      // page 5: take = 50
const workspaces = await prisma.workspace.findMany({ skip: 0, take: skip + limit })
const merged = [...users, ...workspaces].slice(skip, skip + limit)
```

Vấn đề: page càng cao, DB trả càng nhiều items vứt đi.

| Page | Items DB query (cũ) | Items thực dùng |
|------|---------------------|-----------------|
| 1 | 20 | 10 |
| 2 | 40 | 10 |
| 5 | 100 | 10 |
| 100 | 2020 | 10 |

### Cách mới (O(limit))

```ts
// Tính chính xác bao nhiêu user + bao nhiêu workspace cần lấy
const userSkip = Math.min(skip, totalUsers)
const userTake = Math.max(0, Math.min(limit, totalUsers - userSkip))
const workspaceSkip = Math.max(0, skip - totalUsers)
const workspaceTake = Math.max(0, Math.min(limit - userTake, totalWorkspaces - workspaceSkip))

// Query chính xác
const users = await prisma.user.findMany({ skip: userSkip, take: userTake })
const workspaces = await prisma.workspace.findMany({ skip: workspaceSkip, take: workspaceTake })
const merged = [...users, ...workspaces]
```

| Page | Items DB query (mới) | Items thực dùng |
|------|---------------------|-----------------|
| 1 | 10 | 10 |
| 2 | 10 | 10 |
| 5 | 0 (đã hết) | 0 |
| 100 | 0 (đã hết) | 0 |

**Tiết kiệm tới 99% bandwidth khi page cao, không phụ thuộc vào skip.**

---

## 8. Đảm bảo thứ tự ổn định

Để tránh kết quả bị "nhảy" giữa các page (ví dụ user mới được insert vào giữa 2 request), cần `orderBy` cố định:

```ts
prisma.user.findMany({
  orderBy: { createdAt: 'desc' }  // hoặc { id: 'asc' }
})
```

Như vậy:
- Page 1 trả về users/ws có `createdAt` lớn nhất
- Page 2 lấy tiếp theo `createdAt` lớn nhất còn lại
- Kể cả có data mới insert, nó sẽ xuất hiện ở page 1 (không chen vào giữa các page cũ)

---

## 9. Edge cases

### 9.1. `skip > total` (page vượt quá)
- `userTake = 0`, `workspaceTake = 0`
- Cả 2 query trả `[]`
- Response: `{ items: [], total, totalPages }` — frontend biết hết data

### 9.2. `totalUsers = 0, totalWorkspaces = 5`
- Page 1, skip=0: `userTake = 0`, `workspaceSkip = 0`, `workspaceTake = min(10, 5) = 5`
- Trả `[w1..w5]`

### 9.3. `totalUsers = 0, totalWorkspaces = 0`
- Cả 2 query đều `take = 0` → `Promise.resolve([])`
- Trả `[]`, `totalPages = 0`

### 9.4. Không có search
- Nhánh `if (!search)`: chỉ query users với `skip, take` trực tiếp trong DB
- Không cần merge, không cần workspaces

---

## 10. Tóm tắt một dòng

**Tính trước vị trí `skip` rơi vào phần users hay workspaces, từ đó suy ra `skip/take` chính xác cho từng bảng DB, query song song 2 bảng với đúng số items cần thiết, merge theo thứ tự users-trước-workspaces-sau.**
