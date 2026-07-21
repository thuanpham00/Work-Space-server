import { ChannelType } from '~/constants/enum'
import databaseServices from './database.services'

class ChannelService {
  async getDirectMessageChannels(userId: bigint) {
    const channels = await databaseServices.prisma.channel.findMany({
      where: {
        type: ChannelType.DM,
        members: {
          some: {
            userId: userId
          }
        }
      }
    })
    return channels.map((item) => {
      return {
        ...item,
        id: item.id.toString()
      }
    })
  }
}

export default new ChannelService()
