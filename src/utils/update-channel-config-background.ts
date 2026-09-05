import 'dotenv/config'
import databaseServices from '../services/database.services'

const BACKGROUND_URL = ''

async function main() {
  await databaseServices.connect()
  const prisma = databaseServices.prisma

  const result = await prisma.channelConfig.updateMany({
    data: {
      backgroundUrl: BACKGROUND_URL
    }
  })

  console.log(`✅ Đã cập nhật thành công ${result.count} bản ghi.`)

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
