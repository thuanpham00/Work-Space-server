import 'dotenv/config'
import databaseServices from '../services/database.services'

const BACKGROUND_URL = ''
const BACKGROUND_COLOR = '#090909'

async function main() {
  await databaseServices.connect()
  const prisma = databaseServices.prisma

  console.log(
    `🔄 Đang cập nhật channel_configs: background_url = "" và background_color = "${BACKGROUND_COLOR}"...`
  )

  const result = await prisma.channelConfig.updateMany({
    data: {
      backgroundUrl: BACKGROUND_URL,
      backgroundColor: BACKGROUND_COLOR
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
