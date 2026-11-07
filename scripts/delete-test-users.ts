/**
 * Script xóa user test theo danh sách email.
 *
 * Usage:
 *   npx tsx scripts/delete-test-users.ts                        # DRY RUN - chỉ xem báo cáo
 *   npx tsx scripts/delete-test-users.ts --confirm               # THỰC SỰ XÓA (danh sách mặc định)
 *   npx tsx scripts/delete-test-users.ts a@b.com c@d.com --confirm  # XÓA theo email truyền vào
 *
 * Mô tả:
 * - Tìm user theo email (TEST_USER_EMAILS hoặc từ argv).
 * - Xóa theo thứ tự phụ thuộc (bảng con trước, bảng cha sau):
 *   1. Bảng trung gian / con trực tiếp của user
 *   2. Nội dung thuộc workspace/channel mà user là owner
 *   3. Cuối cùng xóa bản ghi trong bảng `users`
 */
import 'dotenv/config'
import { Client } from 'pg'

const DEFAULT_TEST_USER_EMAILS = [
  'newuser_plan1@test.com',
  'newuser_plan1b@test.com'
]

const CONFIRM = process.argv.includes('--confirm')
const CLI_EMAILS = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const TEST_USER_EMAILS = CLI_EMAILS.length ? CLI_EMAILS : DEFAULT_TEST_USER_EMAILS

/**
 * Danh sách bảng cần dọn theo thứ tự: con trước -> cha sau.
 * Mỗi entry: { table, column, label } — xóa các row có column = userId.
 */
const DIRECT_CHILD_TABLES: Array<{ table: string; column: string; label: string }> = [
  // --- Trung gian / con trực tiếp ---
  { table: 'message_reactions', column: 'user_id', label: 'MessageReaction' },
  { table: 'pinned_messages', column: 'pinned_by', label: 'PinnedMessage' },
  { table: 'channel_member_nicknames', column: 'user_id', label: 'ChannelMemberNickname' },
  { table: 'channel_read_states', column: 'user_id', label: 'ChannelReadState' },
  { table: 'user_settings', column: 'userId', label: 'UserSetting' },
  { table: 'refresh_tokens', column: 'user_id', label: 'RefreshToken' },
  { table: 'channel_invites', column: 'created_by_id', label: 'ChannelInvite(createdBy)' },
  { table: 'channel_invites', column: 'revoked_by_id', label: 'ChannelInvite(revokedBy)' },
  { table: 'channel_members', column: 'invited_by_id', label: 'ChannelMember(invitedBy)' },
  { table: 'workspace_members', column: 'invited_by_id', label: 'WorkspaceMember(invitedBy)' },
  { table: 'workspace_members', column: 'requested_by_id', label: 'WorkspaceMember(requestedBy)' },
  { table: 'notifications', column: 'user_id', label: 'Notification(user)' },
  { table: 'notifications', column: 'actor_id', label: 'Notification(actor)' },
  { table: 'messages', column: 'sender_id', label: 'Message(sender)' },
  { table: 'friends', column: 'requester_id', label: 'Friend(requester)' },
  { table: 'friends', column: 'addressee_id', label: 'Friend(addressee)' },
  { table: 'channel_members', column: 'user_id', label: 'ChannelMember(user)' },
  { table: 'workspace_members', column: 'user_id', label: 'WorkspaceMember(user)' }
]

const main = async () => {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL / DIRECT_URL chưa được set trong .env')

  const client = new Client({ connectionString: url })
  await client.connect()
  console.log('✅ Đã kết nối database\n')

  // 1. Tìm user
  const { rows: users } = await client.query(
    `SELECT id, email, username, display_name FROM users WHERE email = ANY($1) ORDER BY id`,
    [TEST_USER_EMAILS]
  )

  const foundEmails = users.map((u) => u.email)
  const missing = TEST_USER_EMAILS.filter((e) => !foundEmails.includes(e))
  if (missing.length) console.log(`⚠️  Không tìm thấy: ${missing.join(', ')}\n`)

  if (!users.length) {
    console.log('Không có user nào khớp. Không làm gì.')
    await client.end()
    return
  }

  const userIds = users.map((u) => String(u.id))
  console.log('🎯 User sẽ xóa:')
  console.table(users)

  // 2. Báo cáo các bảng liên quan
  const report: Array<{ label: string; rows: number; detail: string }> = []
  for (const { table, column, label } of DIRECT_CHILD_TABLES) {
    const { rows } = await client.query(
      `SELECT "${column}"::text AS uid, COUNT(*)::int AS cnt FROM ${table} WHERE "${column}" = ANY($1::bigint[]) GROUP BY 1`,
      [userIds]
    )
    if (!rows.length) continue
    const total = rows.reduce((s, r) => s + r.cnt, 0)
    const detail = rows.map((r) => `user#${r.uid}=${r.cnt}`).join(', ')
    report.push({ label: `${label} [${table}.${column}]`, rows: total, detail })
  }

  // 3. Workspace mà user là owner
  const { rows: ownedWorkspaces } = await client.query(
    `SELECT w.id, w.name, w.owner_id,
            (SELECT COUNT(*)::int FROM workspace_members m WHERE m.workspace_id = w.id) AS member_count,
            (SELECT COUNT(*)::int FROM channels c WHERE c.workspace_id = w.id) AS channel_count
     FROM workspaces w WHERE w.owner_id = ANY($1::bigint[])`,
    [userIds]
  )
  for (const w of ownedWorkspaces) {
    report.push({
      label: `Workspace [workspaces] owner`,
      rows: 1,
      detail: `workspace#${w.id} "${w.name ?? ''}" (members=${w.member_count}, channels=${w.channel_count})`
    })
  }

  console.log('\n📋 Bảng liên quan sẽ bị ảnh hưởng:')
  if (!report.length) console.log('  (không có dữ liệu liên quan)')
  else console.table(report)

  if (!CONFIRM) {
    console.log('\n🔎 DRY RUN — chưa xóa gì. Chạy lại với --confirm để thực sự xóa.')
    await client.end()
    return
  }

  // 4. Xóa trong transaction
  console.log('\n🗑️  Bắt đầu xóa (transaction)...')
  await client.query('BEGIN')
  try {
    for (const { table, column, label } of DIRECT_CHILD_TABLES) {
      const { rowCount } = await client.query(
        `DELETE FROM ${table} WHERE "${column}" = ANY($1::bigint[])`,
        [userIds]
      )
      if (rowCount) console.log(`  ✔ ${label}: ${rowCount} row`)
    }

    // Xóa workspace mà user là owner (cascade channel/category/member/message...)
    for (const w of ownedWorkspaces) {
      const { rowCount } = await client.query(`DELETE FROM workspaces WHERE id = $1`, [w.id])
      console.log(`  ✔ Workspace #${w.id}: ${rowCount} row`)
    }

    // Cuối cùng xóa user
    const { rowCount } = await client.query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [userIds])
    console.log(`  ✔ User: ${rowCount} row`)

    await client.query('COMMIT')
    console.log('\n✅ Xóa thành công!')
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('\n❌ Lỗi, đã rollback:', err)
    throw err
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
