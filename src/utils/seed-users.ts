import 'dotenv/config'
import { config } from 'dotenv'
import path from 'path'
import { createHash } from 'crypto'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { PrismaClient } from '../generated/prisma/client'
// @ts-expect-error - file .js thuần, không có type
import usersData from './users-data.js'

// Ép dotenv đọc file .env theo đường dẫn tuyệt đối (cwd đôi khi tsx không trỏ đúng root)
// Tránh trường hợp "injected env (0) from .env"
config({ path: path.resolve(process.cwd(), '.env'), override: true })
config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

function sha256(content: string) {
  return createHash('sha256').update(content).digest('hex')
}

function hashPassword(password: string) {
  const salt = process.env.SECRET_KEY_HASH_PASSWORD
  if (!salt) {
    throw new Error(
      'SECRET_KEY_HASH_PASSWORD is not set - hãy thêm dòng SECRET_KEY_HASH_PASSWORD="..." vào .env'
    )
  }
  return sha256(password + salt)
}

function createMariaDbAdapter() {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set')
  }

  const parsed = new URL(url)

  return new PrismaMariaDb({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1)
  })
}

// Enum Gender trong Prisma: MALE | FEMALE | OTHER
const VALID_GENDERS = new Set(['MALE', 'FEMALE', 'OTHER'])

async function main() {
  const prisma = new PrismaClient({ adapter: createMariaDbAdapter() })

  // Debug nhanh để biết env có load không
  console.log('🔍 ENV check:')
  console.log('   - DATABASE_URL         :', process.env.DATABASE_URL ? '✅ có' : '❌ thiếu')
  console.log(
    '   - SECRET_KEY_HASH_PASSWORD:',
    process.env.SECRET_KEY_HASH_PASSWORD ? '✅ có (length=' + process.env.SECRET_KEY_HASH_PASSWORD.length + ')' : '❌ thiếu'
  )
  console.log('   - Số user sẽ seed      :', usersData.length)

  console.log(`\n🌱 Bắt đầu seed ${usersData.length} user...`)

  let created = 0
  let skipped = 0

  for (const [index, u] of usersData.entries()) {
    try {
      const gender = u.gender && VALID_GENDERS.has(u.gender) ? u.gender : null

      const data = {
        email: String(u.email).trim().toLowerCase(),
        password: hashPassword(u.password),
        username: u.username ?? null,
        fullName: u.fullName ?? null,
        displayName: u.displayName ?? u.username ?? null,
        phone: u.phone ?? null,
        dateOfBirth: u.dateOfBirth ?? null,
        gender: gender as any
      }

      const existsByEmail = await prisma.user.findUnique({ where: { email: data.email } })
      if (existsByEmail) {
        console.log(`   ⏭️  [${index + 1}] Bỏ qua: email "${data.email}" đã tồn tại`)
        skipped++
        continue
      }

      if (data.username) {
        const existsByUsername = await prisma.user.findUnique({
          where: { username: data.username }
        })
        if (existsByUsername) {
          console.log(`   ⏭️  [${index + 1}] Bỏ qua: username "${data.username}" đã tồn tại`)
          skipped++
          continue
        }
      }

      await prisma.user.create({ data })
      console.log(`   ✅ [${index + 1}] Đã tạo: ${data.email}`)
      created++
    } catch (err: any) {
      console.error(`   ❌ [${index + 1}] Lỗi khi tạo user ${u.email}:`, err?.message ?? err)
    }
  }

  console.log(`\n📊 Tổng kết:`)
  console.log(`   - Tạo mới: ${created}`)
  console.log(`   - Bỏ qua  : ${skipped}`)
  console.log(`   - Tổng số : ${usersData.length}`)

  await prisma.$disconnect()
}

main()
  .then(async () => {
    process.exit(0)
  })
  .catch(async (e) => {
    console.error('💥 Seed thất bại:', e)
    process.exit(1)
  })
