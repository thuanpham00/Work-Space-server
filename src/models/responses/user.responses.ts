import { FriendStatusRequest, TokenType } from '~/constants/enum'

export enum UserStatus {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
  AWAY = 'AWAY',
  BUSY = 'BUSY'
}

export interface User {
  id: string
  email: string
  username: string | null
  displayName: string | null
  avatar: string | null
  fullname: string | null
  status: UserStatus
  bio: string | null
  phone: string | null
  dateOfBirth: string | null
  createdAt: Date
  updatedAt: Date
  gender: string | null
  friendStatus?: FriendStatusRequest | null
  privacySettings?: {
    showEmail: boolean
    showPhone: boolean
    showDateOfBirth: boolean
    showGender: boolean
  }
}

export interface TokenPayload {
  user_id: string
  tokenType: TokenType
  exp: number
  iat: number
}

export interface AuthResponse {
  access_token: string
  user: User
}

export interface ApiResponse<T> {
  message: string
  data?: T
  error?: string
}
