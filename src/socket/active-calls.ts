/**
 * Quản lý các active call (in-memory). Hỗ trợ:
 * - Tạo / lấy / xóa call theo conversationId.
 * - Đảm bảo chỉ có 1 call tại một thời điểm giữa hai user trong cùng conversation.
 * - Cleanup timer an toàn để không leak timeout.
 *
 * Lưu ý: in-memory, chỉ phù hợp 1 server instance. Khi scale cần thay bằng Redis.
 */

import { ActiveCallRecord, CallStatus } from './call.types'
import { getSocketIds } from './online-users'

const activeCalls = new Map<string, ActiveCallRecord>()

const RINGING_TIMEOUT_MS = 30_000

export const isUserInAnyCall = (userId: string): boolean => {
  for (const call of activeCalls.values()) {
    if (call.callerId === userId || call.receiverId === userId) return true
  }
  return false
}

export const getActiveCallForUser = (userId: string): ActiveCallRecord | null => {
  for (const call of activeCalls.values()) {
    if (call.callerId === userId || call.receiverId === userId) return call
  }
  return null
}

export const getActiveCallByConversation = (conversationId: string): ActiveCallRecord | null => {
  return activeCalls.get(conversationId) ?? null
}

export type CreateCallParams = {
  conversationId: string
  callerId: string
  receiverId: string
  isVideo: boolean
  callerSocketId: string
  receiverSocketId: string | null
}

export const createCallIfPossible = async (
  params: CreateCallParams
): Promise<{
  ok: boolean
  reason?: string
  call?: ActiveCallRecord
}> => {
  const { conversationId, callerId, receiverId, isVideo, callerSocketId } = params

  if (activeCalls.has(conversationId)) {
    return { ok: false, reason: 'CALL_EXISTS' }
  }
  if (isUserInAnyCall(callerId)) {
    return { ok: false, reason: 'CALL_EXISTS' }
  }
  if (isUserInAnyCall(receiverId)) {
    return { ok: false, reason: 'CALL_EXISTS' }
  }

  const record: ActiveCallRecord = {
    conversationId,
    callerId,
    receiverId,
    isVideo,
    status: CallStatus.CALLING,
    callerSocketId,
    receiverSocketId: null,
    createdAt: Date.now(),
    ringingTimer: null
  }

  activeCalls.set(conversationId, record)
  return { ok: true, call: record }
}

export const attachReceiverSocket = (conversationId: string, receiverSocketId: string): boolean => {
  const call = activeCalls.get(conversationId)
  if (!call) return false
  call.receiverSocketId = receiverSocketId
  return true
}

export const updateCallStatus = (conversationId: string, status: CallStatus): ActiveCallRecord | null => {
  const call = activeCalls.get(conversationId)
  if (!call) return null
  call.status = status
  return call
}

const clearTimer = (call: ActiveCallRecord) => {
  if (call.ringingTimer) {
    clearTimeout(call.ringingTimer)
    call.ringingTimer = null
  }
}

/**
 * Xóa call khỏi registry và đảm bảo clear timer.
 * Trả về record trước khi xóa (hoặc null nếu không có).
 */
export const removeCall = (conversationId: string): ActiveCallRecord | null => {
  const call = activeCalls.get(conversationId)
  if (!call) return null
  clearTimer(call)
  activeCalls.delete(conversationId)
  return call
}

export const startRingingTimeout = (conversationId: string, onTimeout: (call: ActiveCallRecord) => void): void => {
  const call = activeCalls.get(conversationId)
  if (!call) return
  clearTimer(call)
  call.ringingTimer = setTimeout(() => {
    const c = activeCalls.get(conversationId)
    if (!c) return
    // chỉ fire nếu vẫn đang ở trạng thái chờ accept
    if (c.status === CallStatus.CALLING) {
      onTimeout(c)
    }
  }, RINGING_TIMEOUT_MS)
}

export const cancelRingingTimeout = (conversationId: string): void => {
  const call = activeCalls.get(conversationId)
  if (!call) return
  clearTimer(call)
}

/**
 * Tìm tất cả call liên quan tới user (dùng cho cleanup disconnect).
 */
export const findCallsByUser = (userId: string): ActiveCallRecord[] => {
  const result: ActiveCallRecord[] = []
  for (const call of activeCalls.values()) {
    if (call.callerId === userId || call.receiverId === userId) {
      result.push(call)
    }
  }
  return result
}

export const getPeerUserId = (call: ActiveCallRecord, userId: string): string | null => {
  if (call.callerId === userId) return call.receiverId
  if (call.receiverId === userId) return call.callerId
  return null
}

export const getPeerSocketIds = (call: ActiveCallRecord, userId: string): string[] => {
  const peerId = getPeerUserId(call, userId)
  if (!peerId) return []
  return getSocketIds(peerId)
}

export { RINGING_TIMEOUT_MS }
