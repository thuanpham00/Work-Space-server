export interface Attachment {
  createdAt: string
  fileName: string
  fileSize: string
  fileUrl: string
  id: string
  messageId: string
  mimeType: string
}

export enum AttachmentType {
  IMAGE = 'image',
  FILE = 'file'
}
