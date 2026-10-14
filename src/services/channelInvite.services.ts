import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { ChannelInviteStatus } from '~/models/responses/channel.response'
import databaseServices from '~/services/database.services'

class ChannelInvite {
  async getChannelByInviteCode(code: string) {
    const invite = await databaseServices.prisma.channelInvite.findUnique({
      where: { code },
      include: {
        channel: {
          select: {
            id: true,
            name: true,
            description: true,
            type: true,
            createdAt: true
          }
        }
      }
    })

    if (
      !invite ||
      invite.status !== ChannelInviteStatus.ACTIVE ||
      (invite.expiresAt !== null && invite.expiresAt.getTime() <= Date.now())
    ) {
      throw new ErrorWithStatus({
        message: 'Link mời không hợp lệ hoặc đã hết hạn',
        status: httpStatus.NOTFOUND
      })
    }

    return {
      channelId: invite.channel.id.toString()
    }
  }
}

export default new ChannelInvite()
