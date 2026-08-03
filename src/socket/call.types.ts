/**
 * Types cho signaling Call 1-1 giữa backend và frontend.
 *
 * Quy ước:
 * - Mọi ID trên wire protocol đều là string (an toàn khi serialize JSON, tránh bigint).
 * - Backend dùng bigint nội bộ, convert sang string khi trả payload.
 * - Caller luôn được lấy từ JWT đã verify (socket.data.userId), không tin client gửi.
 */

export type CallParticipant = {
  id: string
  name: string
  avatar?: string
}

export type CallPayload = {
  conversationId: string // map với channelId của backend
  caller: CallParticipant
  receiver: CallParticipant
  isVideo: boolean
}

export type SDPPayload = CallPayload & {
  sdp: RTCSessionDescriptionInit
}

export type IcePayload = CallPayload & {
  candidate: RTCIceCandidateInit
}

export type EndPayload = {
  conversationId: string
}

export type CallErrorPayload = {
  conversationId?: string
  code: CallErrorCode
  message: string
}

export enum CallErrorCode {
  USER_OFFLINE = 'USER_OFFLINE',
  CALL_EXISTS = 'CALL_EXISTS',
  INVALID_PARTICIPANT = 'INVALID_PARTICIPANT',
  CALL_NOT_FOUND = 'CALL_NOT_FOUND',
  NOT_ALLOWED = 'NOT_ALLOWED',
  BAD_PAYLOAD = 'BAD_PAYLOAD'
}

export enum CallEvent {
  // Client -> Server
  CALL_START = 'call:start',
  CALL_ACCEPT = 'call:accept',
  CALL_REJECT = 'call:reject',
  CALL_OFFER = 'call:offer',
  CALL_ANSWER = 'call:answer',
  CALL_ICE = 'call:ice',
  CALL_END = 'call:end',

  // Server -> Client
  INCOMING_CALL = 'incoming-call',
  CALL_ACCEPTED = 'call:accepted',
  CALL_REJECTED = 'call:rejected',
  // Lưu ý: 'call:offer', 'call:answer', 'call:ice' được dùng cho cả hai chiều,
  // do frontend gửi/nhận trên cùng tên event. Do đó không khai báo thêm alias.
  CALL_ENDED = 'call:ended',
  CALL_ERROR = 'call:error'
}

export enum CallStatus {
  CALLING = 'CALLING', // chờ receiver accept
  CONNECTING = 'CONNECTING', // đã accept, đang trao đổi SDP/ICE
  CONNECTED = 'CONNECTED', // ICE đã connected
  ENDED = 'ENDED'
}

export type ActiveCallRecord = {
  conversationId: string
  callerId: string
  receiverId: string
  isVideo: boolean
  status: CallStatus
  callerSocketId: string
  receiverSocketId: string | null
  createdAt: number
  ringingTimer: NodeJS.Timeout | null
}
