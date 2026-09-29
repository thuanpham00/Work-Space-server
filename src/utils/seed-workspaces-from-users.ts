/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Seed script: TRUNCATE toàn bộ data Supabase + tạo lại workspace mặc định cho user trong users-data.js.
 *
 * - Bước 1 (TRUNCATE): xóa TOÀN BỘ rows của mọi bảng + reset auto-increment về 1
 *     - Dùng `TRUNCATE ... RESTART IDENTITY CASCADE` (Postgres / Supabase)
 *     - CASCADE: tự xóa các bảng có FK (Channel → Workspace, ChannelMember → Channel/User, ...)
 *     - RESTART IDENTITY: reset sequence về 1 → ID bắt đầu lại từ 1
 *
 * - Bước 2 (seed): với mỗi user trong users-data.js:
 *     1. Tạo user mới (hash password "User@123456" + đầy đủ fields + UserSetting)
 *     2. Tạo workspace default "Workspace mặc định của {lastName}" qua `workspaceServices.createWorkspaceForUser`
 *        → service này đã tự tạo: Workspace, WorkspaceMember (OWNER), CategoryChannel, Channel (3 default),
 *          ChannelMember (ADMIN), ChannelConfig, ChannelInvite (ACTIVE), ChannelMemberNickname.
 *
 * Cách chạy:
 *   npx tsx src/utils/seed-workspaces-from-users.ts
 *
 * Hoặc qua npm script:
 *   npm run seed:workspaces-from-users
 *
 * Env override (optional):
 *   SEED_SKIP_TRUNCATE=1   → bỏ qua bước TRUNCATE, chỉ seed (mặc định: chạy TRUNCATE)
 *   SEED_SKIP_SEED=1       → chỉ TRUNCATE, không seed
 */

import databaseServices from '~/services/database.services'
import workspaceServices from '~/services/workspace.services'
import { hashPassword } from '~/utils/scripto'
// @ts-ignore — file .js không có type declaration
import usersData from './users-data.js'

interface UserSeed {
  email: string
  phone: string
  username: string
  fullName: string
  displayName: string
  dateOfBirth: string
  gender: 'MALE' | 'FEMALE' | 'OTHER'
  password: string
}

/**
 * Lấy từ cuối cùng của fullName (theo space).
 * - "Nguyễn Văn An" → "An"
 * - "Bảo Lâm" → "Lâm"
 * - "" → "User"
 */
function getLastWord(fullName: string): string {
  const trimmed = (fullName ?? '').trim()
  if (!trimmed) return 'User'
  const parts = trimmed.split(/\s+/)
  return parts[parts.length - 1]
}

/**
 * Danh sách TẤT CẢ các bảng trong schema cần truncate.
 *
 * Thứ tự KHÔNG quan trọng vì dùng CASCADE (Postgres tự tìm thứ tự đúng).
 * Tuy nhiên liệt kê theo "domain" cho dễ audit.
 *
 * ⚠️ Khi thêm bảng mới vào schema.prisma, PHẢI thêm vào đây.
 */
const ALL_TABLES = [
  // User domain
  'user_settings',
  'refresh_tokens',
  'friends',
  // Workspace domain
  'workspace_members',
  'category_channels',
  'workspaces',
  // Channel domain
  'channel_member_nicknames',
  'channel_invites',
  'channel_configs',
  'channel_members',
  'channels',
  'channel_read_states',
  'pinned_messages',
  // Message domain
  'message_reactions',
  'attachments',
  'messages',
  'emojis',
  // User cuối cùng (vì nhiều bảng FK vào users)
  'users'
]

/**
 * Step 1: TRUNCATE toàn bộ bảng + RESTART IDENTITY (reset auto-increment về 1).
 *
 * `TRUNCATE ... RESTART IDENTITY CASCADE`:
 *   - TRUNCATE          → xóa toàn bộ rows, nhanh hơn DELETE (không trigger FK check row-by-row)
 *   - RESTART IDENTITY  → reset sequence (BigInt auto-increment) về 1
 *   - CASCADE           → tự động TRUNCATE các bảng có FK tham chiếu (vd: channels → workspaces)
 */
async function truncateAll() {
  console.log('━━━ STEP 1: TRUNCATE TOÀN BỘ DATA ━━━\n')

  // Đếm rows trước khi xóa (cho report)
  console.log('   📊 Rows trước khi truncate:')
  for (const table of ALL_TABLES) {
    try {
      const result: any = await databaseServices.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM "${table}"`
      )
      const count = result[0]?.count ?? 0
      console.log(`      ${table.padEnd(30)} ${count}`)
    } catch {
      console.log(`      ${table.padEnd(30)} (bảng không tồn tại, bỏ qua)`)
    }
  }
  console.log()

  // TRUNCATE toàn bộ bảng + reset identity + cascade
  const tableList = ALL_TABLES.map((t) => `"${t}"`).join(', ')
  const sql = `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`

  console.log(`   🔥 Chạy: ${sql}\n`)
  await databaseServices.prisma.$executeRawUnsafe(sql)

  // Verify: count sau khi truncate
  console.log('   ✅ Verify rows sau khi truncate (tất cả phải = 0):')
  for (const table of ALL_TABLES) {
    const result: any = await databaseServices.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM "${table}"`
    )
    const count = result[0]?.count ?? 0
    const mark = count === 0 ? '✓' : '✗'
    console.log(`      ${mark} ${table.padEnd(30)} ${count}`)
  }
  console.log()
}

/**
 * Tạo user mới (kèm UserSetting rỗng).
 */
async function createUser(seed: UserSeed): Promise<bigint> {
  const newUser = await databaseServices.prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: seed.email,
        password: hashPassword(seed.password),
        username: seed.username,
        displayName: seed.displayName,
        fullName: seed.fullName,
        phone: seed.phone,
        gender: seed.gender,
        // dateOfBirth schema là String? → truyền raw string "YYYY-MM-DD"
        dateOfBirth: seed.dateOfBirth
      }
    })

    await tx.userSetting.create({
      data: { userId: user.id }
    })

    return user
  })
  return newUser.id
}

/**
 * Step 2: Seed — tạo user + workspace mặc định cho từng user trong users-data.js.
 */
async function seed() {
  console.log('━━━ STEP 2: SEED ━━━\n')

  let createdUserCount = 0
  let createdWsCount = 0
  let errorCount = 0

  for (let i = 0; i < usersData.length; i++) {
    const seed = (usersData as UserSeed[])[i]
    const lastName = getLastWord(seed.fullName)
    const workspaceName = `Workspace mặc định của ${lastName}`

    try {
      console.log(`[${i + 1}/${usersData.length}] ${seed.email} → "${workspaceName}"`)

      // 1. Tạo user mới
      const userId = await createUser(seed)
      console.log(`   + Tạo user mới (id=${userId})`)
      createdUserCount++

      // 2. Tạo workspace default (re-use service logic)
      await workspaceServices.createWorkspaceForUser(userId, workspaceName)
      console.log(`   ✔ Tạo workspace + channel + invite + nickname thành công`)
      createdWsCount++
    } catch (err: any) {
      console.error(`   ✗ Lỗi: ${err.message ?? err}`)
      errorCount++
    }
  }

  console.log('\n=== Tổng kết seed ===')
  console.log(`Tổng user   : ${usersData.length}`)
  console.log(`Tạo user    : ${createdUserCount}`)
  console.log(`Tạo WS      : ${createdWsCount}`)
  console.log(`Lỗi         : ${errorCount}`)
}

async function main() {
  const skipTruncate = process.env.SEED_SKIP_TRUNCATE === '1'
  const skipSeed = process.env.SEED_SKIP_SEED === '1'

  console.log(`▶ Seed workspaces từ users-data.js (${usersData.length} user)`)
  console.log(`  TRUNCATE: ${skipTruncate ? 'SKIP' : 'RUN'}`)
  console.log(`  seed    : ${skipSeed ? 'SKIP' : 'RUN'}\n`)

  if (!skipTruncate) await truncateAll()
  if (!skipSeed) await seed()

  console.log('\n✔ Hoàn tất')
}

main()
  .catch(async (err) => {
    console.error('✗ Lỗi:', err)
    await databaseServices.prisma.$disconnect()
    process.exit(1)
  })
  .finally(async () => {
    await databaseServices.prisma.$disconnect()
  })
