import 'dotenv/config'
import databaseServices from '../services/database.services'

async function main() {
  // Kết nối tới cơ sở dữ liệu
  await databaseServices.connect()
  const prisma = databaseServices.prisma

  console.log('🔄 Đang cập nhật privacySettings cho tất cả người dùng...')

  const defaultPrivacySettings = {
    showEmail: true,
    showPhone: true,
    showBirthday: true,
    showGender: true
  }

  // Cập nhật tất cả các user có privacySettings là null hoặc cập nhật lại toàn bộ
  const result = await prisma.user.updateMany({
    data: {
      privacySettings: defaultPrivacySettings
    }
  })

  console.log(`✅ Đã cập nhật thành công cho ${result.count} người dùng.`)
  
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
