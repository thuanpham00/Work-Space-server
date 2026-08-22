import 'dotenv/config'
import databaseServices from '../services/database.services'

async function main() {
  await databaseServices.connect()
  const prisma = databaseServices.prisma

  const channels = await prisma.channel.findMany({
    include: {
      members: {
        select: {
          userId: true
        }
      }
    },
    orderBy: {
      id: 'asc'
    }
  })

  console.log(`🔍 Tìm thấy ${channels.length} channel(s)\n`)

  let totalCreated = 0
  let totalSkipped = 0

  for (const channel of channels) {
    const memberCount = channel.members.length
    console.log(`📢 Channel ${channel.id} (${channel.name ?? 'Không tên'}): ${memberCount} thành viên`)

    if (memberCount === 0) {
      continue
    }

    const existingNicknames = await prisma.channelMemberNickname.findMany({
      where: {
        channelId: channel.id,
        userId: {
          in: channel.members.map((member) => member.userId)
        }
      },
      select: {
        userId: true
      }
    })

    const existingUserIds = new Set(existingNicknames.map((item) => item.userId.toString()))
    const membersToCreate = channel.members.filter((member) => !existingUserIds.has(member.userId.toString()))

    if (membersToCreate.length === 0) {
      totalSkipped += memberCount
      console.log(`   ↳ Đã có đủ nickname, bỏ qua ${memberCount} thành viên\n`)
      continue
    }

    const result = await prisma.channelMemberNickname.createMany({
      data: membersToCreate.map((member) => ({
        channelId: channel.id,
        userId: member.userId,
        nickname: ''
      }))
    })

    totalCreated += result.count
    totalSkipped += memberCount - result.count

    console.log(`   ↳ Tạo mới ${result.count} nickname, bỏ qua ${memberCount - result.count} thành viên đã có\n`)
  }

  console.log('✅ Hoàn tất')
  console.log(`   • Tổng channel: ${channels.length}`)
  console.log(`   • Nickname tạo mới: ${totalCreated}`)
  console.log(`   • Thành viên đã có nickname: ${totalSkipped}`)

  await databaseServices.disconnect()
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error('❌ Lỗi khi chạy script:', error)
    process.exit(1)
  })
