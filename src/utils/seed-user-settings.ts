/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Backfill script: tạo UserSetting cho mọi user chưa có.
 * Chạy 1 lần sau khi thêm bảng user_settings.
 *
 * Cách chạy:
 *   npx tsx src/utils/seed-user-settings.ts
 *
 * Hoặc qua npm script:
 *   npm run seed:user-settings
 */

import databaseServices from '~/services/database.services'

async function main() {
  console.log('▶ Bắt đầu backfill UserSetting...')

  // Lấy toàn bộ user (chỉ cần id)
  const users = await databaseServices.prisma.user.findMany({
    select: { id: true }
  })

  console.log(`   Tìm thấy ${users.length} user`)

  // Lấy user đã có setting để loại trừ
  const existingSettings = await databaseServices.prisma.userSetting.findMany({
    select: { userId: true }
  })

  const existingUserIds = new Set(existingSettings.map((s) => s.userId.toString()))
  const missingUsers = users.filter((u) => !existingUserIds.has(u.id.toString()))

  console.log(`   Đã có setting: ${existingUserIds.size}`)
  console.log(`   Cần tạo mới: ${missingUsers.length}`)

  if (missingUsers.length === 0) {
    console.log('✔ Không có gì để làm, toàn bộ user đã có UserSetting.')
    return
  }

  // Dùng createMany — nhanh hơn create từng cái
  const result = await databaseServices.prisma.userSetting.createMany({
    data: missingUsers.map((u) => ({
      userId: u.id
      // workspaceInvitePolicy dùng default EVERYONE ở schema
    })),
    skipDuplicates: true // phòng trường hợp race condition
  })

  console.log(`✔ Đã tạo ${result.count} UserSetting mới.`)
}

main()
  .then(async () => {
    await databaseServices.prisma.$disconnect()
    console.log('▶ Đóng kết nối DB.')
    process.exit(0)
  })
  .catch(async (err) => {
    console.error('✗ Lỗi:', err)
    await databaseServices.prisma.$disconnect()
    process.exit(1)
  })
