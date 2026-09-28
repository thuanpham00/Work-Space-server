/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Backfill script: tạo 1 WorkspaceInvite (ACTIVE) cho mỗi workspace
 * chưa có invite nào đang ACTIVE.
 *
 * Cách chạy:
 *   npx tsx src/utils/seed-workspace-invites.ts
 *
 * Hoặc qua npm script:
 *   npm run seed:workspace-invites
 */

import { v4 as uuidv4 } from 'uuid'
import databaseServices from '~/services/database.services'

async function main() {
  console.log('▶ Bắt đầu backfill WorkspaceInvite...')

  // 1. Lấy toàn bộ workspace
  const workspaces = await databaseServices.prisma.workspace.findMany({
    select: { id: true, name: true, ownerId: true }
  })

  console.log(`   Tìm thấy ${workspaces.length} workspace`)

  if (workspaces.length === 0) {
    console.log('✔ Không có workspace nào, kết thúc.')
    return
  }

  // 2. Lấy các workspace đã có ít nhất 1 invite ACTIVE
  const activeInvites = await databaseServices.prisma.workspaceInvite.findMany({
    where: { status: 'ACTIVE' },
    select: { workspaceId: true }
  })

  const workspacesWithActiveInvite = new Set(activeInvites.map((i) => i.workspaceId.toString()))

  console.log(`   Workspace đã có invite ACTIVE: ${workspacesWithActiveInvite.size}`)

  // 3. Lọc ra workspace cần tạo invite, đồng thời tách riêng các workspace thiếu owner
  const missingOwner: typeof workspaces = []
  const toCreate = workspaces.filter((ws) => {
    if (workspacesWithActiveInvite.has(ws.id.toString())) return false
    if (ws.ownerId == null) {
      missingOwner.push(ws)
      return false
    }
    return true
  })

  console.log(`   Cần tạo invite mới: ${toCreate.length}`)
  console.log(`   Bị bỏ qua (không có owner): ${missingOwner.length}`)

  if (missingOwner.length > 0) {
    for (const ws of missingOwner) {
      console.warn(`   ⚠ Workspace id=${ws.id} name="${ws.name ?? ''}" không có owner, bỏ qua.`)
    }
  }

  if (toCreate.length === 0) {
    console.log('✔ Không có gì để tạo, toàn bộ workspace đã có WorkspaceInvite ACTIVE.')
    return
  }

  // 4. Insert bằng createMany — skipDuplicates đề phòng race condition
  const result = await databaseServices.prisma.workspaceInvite.createMany({
    data: toCreate.map((ws) => ({
      // uuid v4 chuẩn 36 ký tự, bỏ dấu '-' để còn 32 hex, vừa VARCHAR(32)
      code: uuidv4().replace(/-/g, ''),
      workspaceId: ws.id,
      status: 'ACTIVE',
      expiresAt: null,
      createdById: ws.ownerId as bigint,
      revokedAt: null,
      revokedById: null
    })),
    skipDuplicates: true
  })

  console.log(`✔ Đã tạo ${result.count} WorkspaceInvite mới.`)
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
