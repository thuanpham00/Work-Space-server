import { TokenType } from '~/constants/enum'

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
  bio: string | null
  status: UserStatus
  createdAt: Date
  updatedAt: Date
}

export interface UserResponse {
  id: string
  email: string
  username: string | null
  displayName: string | null
  avatar: string | null
  status: UserStatus
  createdAt: string
}

export interface TokenPayload {
  user_id: string
  tokenType: TokenType
  exp: number
  iat: number
}

export interface AuthResponse {
  access_token: string
  user: UserResponse
}

export interface ApiResponse<T = any> {
  message: string
  data?: T
  error?: string
}
