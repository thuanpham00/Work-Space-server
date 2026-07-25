import { ChannelType } from '~/constants/enum'
import databaseServices from './database.services'

class ChannelService {
  async getDirectMessageChannelDetail(idUser: bigint, idReceiver: bigint) {
    const channel = await databaseServices.prisma.channel.findFirst({
      where: {
        type: ChannelType.DM,
        AND: [{ members: { some: { userId: idUser } } }, { members: { some: { userId: idReceiver } } }]
      },
      include: {
        members: {
          include: {
            user: true
          }
        }
      }
    })

    if (!channel) return null

    const { members, ...restChannel } = channel

    return {
      ...restChannel,
      id: channel.id.toString(),
      workspaceId: channel.workspaceId ? channel.workspaceId.toString() : null,
      friend: members
        .filter((member) => member.userId !== idUser)
        .map((member) => {
          return {
            ...member.user,
            id: member.user.id.toString()
          }
        })[0] || null
    }
  }
}

export default new ChannelService()
