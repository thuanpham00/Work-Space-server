import { ErrorWithStatus } from '~/constants/errors'
import httpStatus from '~/constants/httpStatus'
import { WorkspaceInviteStatus } from '~/generated/prisma/enums'
import databaseServices from '~/services/database.services'

class WorkspaceInvite {
  async getWorkspaceByInviteCode(code: string) {
    const invite = await databaseServices.prisma.workspaceInvite.findUnique({
      where: { code },
      include: {
        workspace: {
          select: {
            id: true,
            name: true,
            description: true,
            avatar: true,
            ownerId: true,
            createdAt: true,
            updatedAt: true
          }
        }
      }
    })

    if (
      !invite ||
      invite.status !== WorkspaceInviteStatus.ACTIVE ||
      (invite.expiresAt !== null && invite.expiresAt.getTime() <= Date.now())
    ) {
      throw new ErrorWithStatus({
        message: 'Link mời không hợp lệ hoặc đã hết hạn',
        status: httpStatus.NOTFOUND
      })
    }

    return {
      code: invite.code,
      workspace: {
        id: invite.workspace.id.toString(),
        name: invite.workspace.name,
        description: invite.workspace.description,
        avatar: invite.workspace.avatar,
        ownerId: invite.workspace.ownerId ? invite.workspace.ownerId.toString() : null,
        createdAt: invite.workspace.createdAt.toISOString(),
        updatedAt: invite.workspace.updatedAt.toISOString()
      },
      expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
      createdById: invite.createdById.toString()
    }
  }
}

export default new WorkspaceInvite()
