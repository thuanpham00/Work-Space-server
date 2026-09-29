export enum TokenType {
  AccessToken,
  RefreshToken
}

export enum MediaType {
  Image,
  Video
}

export enum ChannelType {
  TEXT = 'TEXT',
  VOICE = 'VOICE',
  DM = 'DM'
}

export enum WorkspaceMemberRole {
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
  OWNER = 'OWNER'
}

export enum MemberStatus {
  ACTIVE = 'ACTIVE',
  LEFT = 'LEFT',
  BANNED = 'BANNED',
  PENDING_REQUEST = 'PENDING_REQUEST',
  PENDING_INVITE = 'PENDING_INVITE',
  CANCELED = 'CANCELED'
}

export enum ChannelMemberRole {
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER'
}

export enum WorkMode {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
  AWAY = 'AWAY',
  BUSY = 'BUSY'
}

export const UserStatus = WorkMode
export type UserStatus = WorkMode

export enum MessageType {
  TEXT = 'TEXT',
  CONFIG = 'CONFIG',
  GIF = 'GIF'
}

export enum FriendStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  BLOCKED = 'BLOCKED'
}

export enum FriendStatusRequest {
  REQUEST_SENT = 'REQUEST_SENT',
  REQUEST_RECEIVED = 'REQUEST_RECEIVED',
  ACCEPTED = 'ACCEPTED'
}

export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER'
}

export enum WorkspaceInvitePolicy {
  EVERYONE = 'EVERYONE',
  FRIENDS_ONLY = 'FRIENDS_ONLY'
}
