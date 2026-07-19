export interface Workspace {
  id: string
  name: string
  description: string | null
  avatar: string | null
  ownerId: string
  createdAt: string
  updatedAt: string
}
