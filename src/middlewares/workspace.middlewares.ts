import { NextFunction, Response } from 'express'
import httpStatus from '~/constants/httpStatus'
import { ErrorWithStatus } from '~/constants/errors'
import databaseServices from '~/services/database.services'
import { MemberStatus, WorkspaceMemberRole } from '~/constants/enum'
import { TokenPayload } from '~/models/responses/user.responses'
import { AuthenticatedRequest } from '~/models/requests/user.requests'

export const workspaceAdminValidator = (
  allowedRoles: WorkspaceMemberRole[] = [WorkspaceMemberRole.OWNER, WorkspaceMemberRole.ADMIN]
) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const workspaceIdRaw = req.params.workspaceId as string
    const { user_id } = req.decode_authorization as TokenPayload

    if (!workspaceIdRaw || !user_id) {
      throw new ErrorWithStatus({
        message: 'Thiếu workspaceId hoặc user_id',
        status: httpStatus.BAD_REQUESTED
      })
    }

    const userId = BigInt(user_id)
    const workspaceId = BigInt(workspaceIdRaw)

    const member = await databaseServices.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { status: true, role: true }
    })

    if (!member) {
      throw new ErrorWithStatus({
        message: 'Bạn không thuộc workspace này',
        status: httpStatus.FORBIDDEN
      })
    }

    if (member.status !== MemberStatus.ACTIVE) {
      throw new ErrorWithStatus({
        message: 'Bạn không đủ quyền cho thao tác này',
        status: httpStatus.FORBIDDEN
      })
    }

    if (!allowedRoles.includes(member.role as WorkspaceMemberRole)) {
      throw new ErrorWithStatus({
        message: 'Bạn không đủ quyền cho thao tác này',
        status: httpStatus.FORBIDDEN
      })
    }

    req.workspaceMember = {
      role: member.role as WorkspaceMemberRole,
      status: member.status as MemberStatus
    }
    next()
  }
}

export const checkActiveMembershipValidator = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const workspaceIdRaw = req.params.workspaceId as string
  const { user_id } = req.decode_authorization as TokenPayload

  if (!workspaceIdRaw || !user_id) {
    throw new ErrorWithStatus({
      message: 'Thiếu workspaceId hoặc user_id',
      status: httpStatus.BAD_REQUESTED
    })
  }

  if (!/^\d+$/.test(workspaceIdRaw)) {
    throw new ErrorWithStatus({
      message: 'Không tìm thấy workspace',
      status: httpStatus.NOTFOUND
    })
  }

  const userId = BigInt(user_id)
  const workspaceId = BigInt(workspaceIdRaw)

  const findWorkspace = await databaseServices.prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true }
  })

  if (!findWorkspace) {
    throw new ErrorWithStatus({
      message: 'Không tìm thấy workspace',
      status: httpStatus.NOTFOUND
    })
  }

  const member = await databaseServices.prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { status: true }
  })

  if (!member || member.status !== MemberStatus.ACTIVE) {
    throw new ErrorWithStatus({
      message: 'Bạn không có quyền truy cập workspace này',
      status: httpStatus.FORBIDDEN
    })
  }

  next()
}
