export interface WorkspaceByInviteCodeResponse {
  code: string
  workspace: {
    id: string
    name: string | null
    description: string | null
    avatar: string | null
    ownerId: string | null
    createdAt: string
    updatedAt: string
  }
  expiresAt: string | null
  createdById: string
}
