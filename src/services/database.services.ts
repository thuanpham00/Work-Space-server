import 'dotenv/config'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { PrismaClient } from '../generated/prisma/client'
import { hashPassword } from '~/utils/scripto'

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

class DatabaseService {
  prisma: PrismaClient

  constructor() {
    this.prisma = new PrismaClient({
      adapter: createMariaDbAdapter(),
      log: ['query', 'info', 'warn', 'error']
    })
  }
  async connect() {
    try {
      await this.prisma.$connect()
      console.log('✅ Connected to MySQL')
    } catch (error) {
      console.error('❌ Cannot connect MySQL', error)
      process.exit(1)
    }
  }

  async disconnect() {
    await this.prisma.$disconnect()
  }

  async initAdminUser() {
    const adminEmail = 'admin@workspace.com'
    const adminUsername = 'Admin Workspace'

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: adminEmail }, { username: adminUsername }]
      }
    })

    if (!existingUser) {
      await this.prisma.user.create({
        data: {
          email: adminEmail,
          username: adminUsername,
          displayName: adminUsername,
          password: hashPassword('admin123')
        }
      })
      console.log('✅ Admin user created')
    } else {
      console.log('ℹ️  Admin user already exists')
    }
  }
}

export default new DatabaseService()
