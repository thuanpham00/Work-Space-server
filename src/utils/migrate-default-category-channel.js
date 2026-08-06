require('dotenv/config')
const { PrismaPg } = require('@prisma/adapter-pg')
const { PrismaClient } = require('../generated/prisma/client')
const { Pool } = require('pg')

function createPgAdapter() {
  const url = process.env.DATABASE_URL

  if (!url) {
    throw new Error('DATABASE_URL is not set')
  }

  const parsed = new URL(url)

  return new PrismaPg(
    new Pool({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 5432,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.slice(1)
    })
  )
}

async function main() {
  const prisma = new PrismaClient({
    adapter: createPgAdapter(),
    log: ['info', 'warn', 'error']
  })

  try {
    console.log('🔄 Đang lấy danh sách workspace...')

    const workspaces = await prisma.workspace.findMany({
      select: {
        id: true,
        name: true
      },
      orderBy: {
        id: 'asc'
      }
    })

    console.log(`📦 Tìm thấy ${workspaces.length} workspace.`)

    let createdCategories = 0
    let updatedChannels = 0

    for (const workspace of workspaces) {
      const category = await prisma.categoryChannel.upsert({
        where: {
          workspaceId_name: {
            workspaceId: workspace.id,
            name: 'Chung'
          }
        },
        create: {
          workspaceId: workspace.id,
          name: 'Chung',
          position: 1
        },
        update: {
          position: 1
        }
      })

      createdCategories++

      const channelResult = await prisma.channel.updateMany({
        where: {
          workspaceId: workspace.id
        },
        data: {
          categoryId: category.id
        }
      })

      updatedChannels += channelResult.count

      console.log(
        `✅ Workspace ${workspace.id}${workspace.name ? ` (${workspace.name})` : ''}: category ${category.id} | channels cập nhật: ${channelResult.count}`
      )
    }

    console.log('\n📊 Tổng kết:')
    console.log(`   - Workspace xử lý      : ${workspaces.length}`)
    console.log(`   - Category "Chung" upsert: ${createdCategories}`)
    console.log(`   - Channel đã gắn       : ${updatedChannels}`)
  } finally {
    await prisma.$disconnect()
  }
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error('❌ Script thất bại:', error)
    process.exit(1)
  })