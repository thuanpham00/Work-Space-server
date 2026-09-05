require('dotenv/config')
const { PrismaPg } = require('@prisma/adapter-pg')
const { PrismaClient } = require('../generated/prisma/client')
const { Pool } = require('pg')

const pool = new Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function main() {
  const workspaceMemberResult = await prisma.workspaceMember.updateMany({
    data: {
      role: 'ADMIN'
    }
  })

  console.log(`Updated ${workspaceMemberResult.count} workspace member(s) to ADMIN`)

  const channels = await prisma.channel.findMany({
    where: {
      workspaceId: {
        not: null
      }
    },
    select: {
      id: true,
      workspaceId: true
    }
  })

  console.log(`Found ${channels.length} channel(s) with workspaceId`)

  const channelIds = channels.map((channel) => channel.id)

  if (channelIds.length === 0) {
    console.log('No channel members to update')
    return
  }

  const channelMemberResult = await prisma.channelMember.updateMany({
    where: {
      channelId: {
        in: channelIds
      }
    },
    data: {
      role: 'ADMIN'
    }
  })

  console.log(`Updated ${channelMemberResult.count} channel member(s) to ADMIN`)
  console.log('Done!')
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
