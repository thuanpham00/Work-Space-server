/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Script: Thêm partial unique index cho bảng `workspace_invites`.
 *
 * Mục đích: đảm bảo 1 workspace chỉ có tối đa 1 link ACTIVE ở tầng database.
 * - Nếu 2 transaction cùng insert ACTIVE → 1 sẽ fail với lỗi P2002 (unique violation).
 *
 * Cách chạy:
 *   npx tsx src/utils/add-workspace-invite-indexes.ts
 *
 * Hoặc qua npm script:
 *   npm run db:add-workspace-invite-indexes
 *
 * Lưu ý: Script này dùng `CREATE INDEX IF NOT EXISTS` (idempotent — chạy nhiều lần OK).
 */

import databaseServices from '~/services/database.services'

const STATEMENTS: Array<{ name: string; sql: string }> = [
  {
    name: 'workspace_invites_one_active',
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_invites_one_active
      ON workspace_invites (workspace_id)
      WHERE status = 'active';
    `
  },
  {
    name: 'workspace_invites_workspace_status_active',
    sql: `
      CREATE INDEX IF NOT EXISTS workspace_invites_workspace_status_active
      ON workspace_invites (workspace_id, created_at DESC)
      WHERE status = 'active';
    `
  }
]

async function main() {
  console.log('▶ Bắt đầu thêm partial unique index cho workspace_invites...')

  try {
    for (const stmt of STATEMENTS) {
      const sql = stmt.sql.trim()
      // $executeRawUnsafe không nhận template, dùng chuỗi thuần.
      // Migrations SQL không có tham số → an toàn.
      await databaseServices.prisma.$executeRawUnsafe(sql)
      console.log(`   ✔ Đã tạo/đảm bảo index "${stmt.name}"`)
    }
    console.log('✔ Hoàn tất.')
  } catch (err) {
    console.error('✗ Lỗi khi tạo index:', err)
    process.exitCode = 1
  } finally {
    await databaseServices.prisma.$disconnect()
    console.log('▶ Đóng kết nối DB.')
  }
}

main().catch(async (err) => {
  console.error('✗ Lỗi:', err)
  await databaseServices.prisma.$disconnect()
  process.exit(1)
})
