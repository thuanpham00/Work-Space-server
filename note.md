# Prisma Cheat Sheet

## 1. Annotations thường dùng

| Annotation | Mục đích |
|------------|----------|
| `@id` | Primary Key |
| `@unique` | Giá trị duy nhất, không trùng lặp |
| `@default(value)` | Giá trị mặc định |
| `@map("column_name")` | Đổi tên column trong database |
| `@db.Type(...)` | Kiểu dữ liệu cụ thể trong database |
| `@relation(...)` | Thiết lập quan hệ với model khác |
| `@updatedAt` | Tự động cập nhật thời gian khi thay đổi |
| `@@map("table_name")` | Đổi tên bảng trong database |
| `@@index([...])` | Tạo index cho cột |

---

## 2. Kiểu dữ liệu

### Prisma Type vs MySQL Type

| Prisma Type | MySQL (mặc định) | MySQL (có @db) |
|-------------|------------------|----------------|
| `BigInt` | `BIGINT` | `BIGINT UNSIGNED` |
| `String` | `TEXT` | `VARCHAR(255)` |
| `DateTime` | `DATETIME` | `DATETIME(3)` |
| `Boolean` | `BOOLEAN` | `BOOLEAN` |
| `Int` | `INT` | `INT` |
| `Float` | `FLOAT` | `FLOAT` |

**Ví dụ:**
```prisma
id        BigInt  @db.UnsignedBigInt  // MySQL: BIGINT UNSIGNED
email     String  @db.VarChar(255)    // MySQL: VARCHAR(255)
bio       String? @db.Text             // MySQL: TEXT (nullable)
```

---

## 3. Quan hệ (Relations)

### Các loại quan hệ

| Loại | Ví dụ |
|------|-------|
| 1-1 (one-to-one) | User - RefreshToken |
| 1-n (one-to-many) | User - Messages |
| n-1 (many-to-one) | Message - User (sender) |
| n-n (many-to-many) | User - Roles |

### Khi nào cần @relation

| Trường hợp | Có @relation | Không cần |
|-------------|-------------|-----------|
| Model con có 1 FK duy nhất | ❌ | ✅ |
| Muốn đặt tên relation | ✅ | ❌ |
| Model có 2+ relations đến cùng 1 model | ✅ | ❌ |

**Ví dụ:** Message có 2 relations đến User
```prisma
model Message {
  senderId  BigInt @map("sender_id")
  sender    User   @relation("MessageSender", fields: [senderId], references: [id])
}
```

---

## 4. ON DELETE và ON UPDATE

Ràng buộc khi xóa hoặc cập nhật record cha.

### Các kiểu

| Kiểu | Hành vi |
|------|---------|
| `Cascade` | Xóa/Update record cha → tự động xóa/Update record con |
| `Restrict` | Ngăn chặn xóa/Update record cha nếu còn record con |
| `SetNull` | Xóa/Update record cha → set FK record con = NULL |
| `SetDefault` | Xóa/Update record cha → set FK record con = giá trị mặc định |

### Ví dụ thực tế

```prisma
// Xóa User → xóa luôn RefreshToken
RefreshToken {
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

// Xóa User → Workspace vẫn tồn tại, owner_id = NULL
Workspace {
  ownerId BigInt?
  owner   User? @relation(..., onDelete: SetNull)
}

// Xóa User → Báo lỗi, không cho xóa
Order {
  userId BigInt
  user   User @relation(..., onDelete: Restrict)
}
```

### Bảng quyết định

| Tình huống | Nên dùng |
|------------|----------|
| Xóa User → xóa hết token/đăng nhập | `Cascade` |
| Xóa bài viết → reply vẫn còn nhưng không reply ai | `SetNull` |
| Xóa sản phẩm đang có đơn hàng | `Restrict` |
| Xóa danh mục → gán vào "Khác" | `SetDefault` |

---

## 5. Enum trong Prisma

```prisma
enum UserStatus {
  ONLINE  @map("online")
  OFFLINE @map("offline")
  AWAY    @map("away")
  BUSY    @map("busy")

  @@map("user_status")
}
```

**Kết quả trong MySQL:**
```sql
status ENUM('online', 'offline', 'away', 'busy') NOT NULL DEFAULT 'offline'
```

---

## 6. Lệnh Prisma thường dùng

| Lệnh | Mục đích |
|------|----------|
| `npx prisma generate` | Tạo Prisma Client từ schema |
| `npx prisma migrate dev` | Tạo migration mới và áp dụng |
| `npx prisma migrate deploy` | Áp dụng migration (production) |
| `npx prisma migrate reset` | Xóa hết, chạy lại từ đầu |
| `npx prisma studio` | Mở giao diện quản lý database |
| `npx prisma db push` | Đẩy schema xuống database (không tạo migration) |
