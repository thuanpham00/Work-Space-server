/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Backfill script: cập nhật các record WorkspaceMember có role = OWNER.
 * Chạy 1 lần sau khi bổ sung các field: status, joinedAt, acceptedAt, approvedById, approvedByType.
 *
 * Cách chạy:
 *   npx tsx src/utils/backfill-owner-workspace-members.ts
 *
 * Hoặc qua npm script:
 *   npm run backfill:owner-workspace-members
 */

import { WorkspaceMemberRole } from '~/constants/enum'
import { ApproverType } from '~/generated/prisma/enums'
import { WorkspaceMemberStatus } from '~/models/responses/workspace.response'
import databaseServices from '~/services/database.services'

async function main() {
  console.log('▶ Bắt đầu backfill WorkspaceMember (role = OWNER)...')

  // 1. Lấy toàn bộ owner members (chỉ select field cần thiết)
  const owners = await databaseServices.prisma.workspaceMember.findMany({
    where: { role: WorkspaceMemberRole.OWNER },
    select: {
      workspaceId: true,
      userId: true,
      joinedAt: true
    }
  })

  console.log(`   Tìm thấy ${owners.length} owner member(s)`)

  if (owners.length === 0) {
    console.log('✔ Không có gì để làm.')
    return
  }

  // 2. Lọc các record cần update:
  //    - joinedAt không null (để copy sang acceptedAt)
  const toUpdate = owners.filter((o) => o.joinedAt !== null)
  const skippedNoJoinedAt = owners.length - toUpdate.length

  console.log(`   Có joinedAt: ${toUpdate.length}`)
  console.log(`   Bỏ qua (không có joinedAt): ${skippedNoJoinedAt}`)

  if (toUpdate.length === 0) {
    console.log('✔ Không có record nào cần update (toàn bộ owner thiếu joinedAt).')
    return
  }

  // 3. Update trong transaction với timeout lớn (dữ liệu owner có thể nhiều).
  //    - Dùng interactive transaction (callback) để nhận đúng kiểu PrismaPromise
  //      và có thể đếm success/error từng bản ghi.
  //    - timeout: 30000ms (30s) để tránh lỗi P2028 khi data lớn.
  const TRANSACTION_TIMEOUT_MS = 30_000
  let successCount = 0
  let errorCount = 0

  try {
    await databaseServices.prisma.$transaction(
      async (tx) => {
        for (const o of toUpdate) {
          try {
            await tx.workspaceMember.update({
              where: {
                workspaceId_userId: { workspaceId: o.workspaceId, userId: o.userId }
              },
              data: {
                status: WorkspaceMemberStatus.ACTIVE,
                acceptedAt: o.joinedAt, // copy joinedAt hiện tại
                approvedById: o.userId, // owner tự duyệt chính mình
                approvedByType: ApproverType.USER
              }
            })
            successCount++
          } catch (err) {
            errorCount++
            const message = err instanceof Error ? err.message : String(err)
            console.error(`   ✗ Lỗi workspaceId=${o.workspaceId} userId=${o.userId}:`, message)
          }
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: 10_000 }
    )
  } catch (err) {
    console.error('✗ Transaction lỗi (rollback toàn bộ):', err)
    throw err
  }

  console.log(`✔ Đã update ${successCount} owner record(s).`)
  if (errorCount > 0) console.log(`⚠ Có ${errorCount} record lỗi.`)
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
