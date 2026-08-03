/**
 * Call Gateway: signaling cho Audio/Video call 1-1.
 *
 * Flow chính:
 *   1. Caller gửi `call:start` -> server verify participant, tạo active call, gửi `incoming-call` tới receiver.
 *   2. Receiver gửi `call:accept` -> server chuyển call sang CONNECTING, relay `call:accepted` cho caller.
 *   3. Caller gửi `call:offer` -> server relay tới receiver.
 *   4. Receiver gửi `call:answer` -> server relay tới caller.
 *   5. Hai bên gửi `call:ice` -> server relay qua lại.
 *   6. Một bên gửi `call:end` (hoặc disconnect) -> server relay `call:ended` và cleanup state.
 *
 * Bảo mật:
 *   - Caller server lấy từ JWT (socket.data.userId), KHÔNG tin payload từ client.
 *   - Receiver phải thuộc cùng channel; channel phải là DM hợp lệ.
 *   - Mọi handler đều kiểm tra caller/receiver là participant của active call.
 *   - Mọi handler được bọc try/catch + log để payload xấu không làm crash gateway.
 */

import type { Server, Socket } from 'socket.io'
import { CallErrorCode, CallEvent, CallPayload, CallStatus, EndPayload, IcePayload, SDPPayload } from './call.types'
import {
  attachReceiverSocket,
  cancelRingingTimeout,
  createCallIfPossible,
  findCallsByUser,
  getActiveCallByConversation,
  getPeerSocketIds,
  getPeerUserId,
  removeCall,
  startRingingTimeout,
  updateCallStatus,
  RINGING_TIMEOUT_MS
} from './active-calls'
import { getSocketIds, isOnline } from './online-users'
import { ensureConversationParticipants } from '~/services/call.participants.service'

const safeParse = <T>(payload: any): T | null => {
  if (!payload || typeof payload !== 'object') return null
  return payload as T
}

const emitError = (socket: Socket, code: CallErrorCode, message: string, conversationId?: string) => {
  socket.emit(CallEvent.CALL_ERROR, { code, message, conversationId })
}

const notifyEndToPeers = (io: Server, conversationId: string, callerId: string, receiverId: string, reason: string) => {
  const endedPayload = { conversationId, reason } satisfies EndPayload & { reason?: string }
  for (const uid of [callerId, receiverId]) {
    const sIds = getSocketIds(uid)
    for (const sId of sIds) {
      io.to(sId).emit(CallEvent.CALL_ENDED, endedPayload)
    }
  }
}

const handleTimeout = (io: Server, conversationId: string, callerId: string, receiverId: string) => {
  notifyEndToPeers(io, conversationId, callerId, receiverId, 'Ringing timeout')
  removeCall(conversationId)
}

export const registerCallGateway = (io: Server, socket: Socket) => {
  const userId: string | undefined = socket.data?.userId
  if (!userId) {
    // fallback nếu middleware chưa gắn
    return
  }

  const handleDisconnectCleanup = () => {
    // Cleanup các call cần thông báo peer khi user disconnect.
    const calls = findCallsByUser(userId)
    for (const call of calls) {
      // Gửi tín hiệu end cho cả 2 phía (user đã disconnect không nhận được do socket đã đóng).
      notifyEndToPeers(io, call.conversationId, call.callerId, call.receiverId, 'Peer disconnected')
      removeCall(call.conversationId)
    }
  }

  socket.on('disconnect', () => {
    handleDisconnectCleanup()
  })

  // Lưu ý: presence (add/remove socket cho user) được quản lý bởi caller (src/socket.ts).

  // ----- call:start -----
  socket.on(CallEvent.CALL_START, async (raw: any) => {
    try {
      const payload = safeParse<CallPayload>(raw)
      if (!payload || typeof payload.conversationId !== 'string' || !payload.caller || !payload.receiver) {
        return emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Invalid call:start payload')
      }

      // Server lấy caller từ JWT, không tin client
      const callerId = userId
      const receiverId = payload.receiver?.id
      if (!receiverId || typeof receiverId !== 'string') {
        return emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Missing receiver.id')
      }
      if (callerId === receiverId) {
        return emitError(socket, CallErrorCode.INVALID_PARTICIPANT, 'Cannot call yourself')
      }

      // Kiểm tra receiver online
      if (!isOnline(receiverId)) {
        return emitError(socket, CallErrorCode.USER_OFFLINE, 'Receiver is offline')
      }

      // Kiểm tra channel + participant hợp lệ
      const participants = await ensureConversationParticipants({
        channelId: payload.conversationId,
        callerId,
        receiverId
      })
      if (!participants) {
        return emitError(
          socket,
          CallErrorCode.INVALID_PARTICIPANT,
          'Conversation not found or unauthorized',
          payload.conversationId
        )
      }

      // Chuẩn hóa payload từ server (data luôn đúng từ DB)
      const normalizedPayload: CallPayload = {
        conversationId: participants.channelId,
        caller: participants.caller
          ? {
              id: participants.caller.id,
              name: participants.caller.name,
              avatar: participants.caller.avatar ?? undefined
            }
          : payload.caller,
        receiver: participants.receiver
          ? {
              id: participants.receiver.id,
              name: participants.receiver.name,
              avatar: participants.receiver.avatar ?? undefined
            }
          : payload.receiver,
        isVideo: !!payload.isVideo
      }

      // Tìm 1 socket của receiver để gửi incoming-call
      const receiverSocketIds = getSocketIds(receiverId)
      const receiverSocketId = receiverSocketIds[0]
      if (!receiverSocketId) {
        return emitError(socket, CallErrorCode.USER_OFFLINE, 'Receiver is offline')
      }

      const create = await createCallIfPossible({
        conversationId: normalizedPayload.conversationId,
        callerId,
        receiverId,
        isVideo: normalizedPayload.isVideo,
        callerSocketId: socket.id,
        receiverSocketId
      })

      if (!create.ok || !create.call) {
        return emitError(socket, CallErrorCode.CALL_EXISTS, 'A call already exists', normalizedPayload.conversationId)
      }

      const call = create.call
      attachReceiverSocket(call.conversationId, receiverSocketId)

      // Start 30s ringing timeout
      startRingingTimeout(call.conversationId, (c) => handleTimeout(io, c.conversationId, c.callerId, c.receiverId))

      io.to(receiverSocketId).emit(CallEvent.INCOMING_CALL, normalizedPayload)
    } catch (err) {
      console.error('[call:start] error:', err)
      emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Failed to start call')
    }
  })

  // ----- call:accept -----
  socket.on(CallEvent.CALL_ACCEPT, async (raw: any) => {
    try {
      const payload = safeParse<CallPayload>(raw)
      if (!payload || typeof payload.conversationId !== 'string') {
        return emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Invalid call:accept payload')
      }
      const call = getActiveCallByConversation(payload.conversationId)
      if (!call) {
        return emitError(socket, CallErrorCode.CALL_NOT_FOUND, 'Call not found', payload.conversationId)
      }
      if (call.receiverId !== userId) {
        return emitError(socket, CallErrorCode.NOT_ALLOWED, 'Only the receiver can accept', payload.conversationId)
      }
      if (call.status !== CallStatus.CALLING) {
        return emitError(socket, CallErrorCode.NOT_ALLOWED, 'Call is not in ringing state', payload.conversationId)
      }

      cancelRingingTimeout(call.conversationId)
      attachReceiverSocket(call.conversationId, socket.id)
      updateCallStatus(call.conversationId, CallStatus.CONNECTING)

      // Gửi accepted cho caller (tất cả socket của caller)
      const callerSocketIds = getSocketIds(call.callerId)
      const acceptedPayload: CallPayload = {
        conversationId: call.conversationId,
        caller: payload.caller,
        receiver: payload.receiver,
        isVideo: call.isVideo
      }
      for (const sId of callerSocketIds) {
        io.to(sId).emit(CallEvent.CALL_ACCEPTED, acceptedPayload)
      }
    } catch (err) {
      console.error('[call:accept] error:', err)
      emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Failed to accept call')
    }
  })

  // ----- call:reject -----
  socket.on(CallEvent.CALL_REJECT, async (raw: any) => {
    try {
      const payload = safeParse<CallPayload>(raw)
      if (!payload || typeof payload.conversationId !== 'string') {
        return emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Invalid call:reject payload')
      }
      const call = getActiveCallByConversation(payload.conversationId)
      if (!call) {
        return emitError(socket, CallErrorCode.CALL_NOT_FOUND, 'Call not found', payload.conversationId)
      }
      if (call.receiverId !== userId) {
        return emitError(socket, CallErrorCode.NOT_ALLOWED, 'Only the receiver can reject', payload.conversationId)
      }
      // Gửi rejected cho caller
      const callerSocketIds = getSocketIds(call.callerId)
      const rejectedPayload: CallPayload = {
        conversationId: call.conversationId,
        caller: payload.caller,
        receiver: payload.receiver,
        isVideo: call.isVideo
      }
      for (const sId of callerSocketIds) {
        io.to(sId).emit(CallEvent.CALL_REJECTED, rejectedPayload)
      }
      removeCall(call.conversationId)
    } catch (err) {
      console.error('[call:reject] error:', err)
      emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Failed to reject call')
    }
  })

  // ----- call:offer -----
  socket.on(CallEvent.CALL_OFFER, async (raw: any) => {
    try {
      const payload = safeParse<SDPPayload>(raw)
      if (!payload || typeof payload.conversationId !== 'string' || !payload.sdp) {
        return emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Invalid call:offer payload')
      }
      const call = getActiveCallByConversation(payload.conversationId)
      if (!call) {
        return emitError(socket, CallErrorCode.CALL_NOT_FOUND, 'Call not found', payload.conversationId)
      }
      if (call.callerId !== userId) {
        return emitError(socket, CallErrorCode.NOT_ALLOWED, 'Only the caller can send offer', payload.conversationId)
      }
      if (call.status !== CallStatus.CONNECTING && call.status !== CallStatus.CONNECTED) {
        return emitError(socket, CallErrorCode.NOT_ALLOWED, 'Call is not in connecting state', payload.conversationId)
      }

      // relay tới receiver
      const peerSocketIds = getPeerSocketIds(call, userId)
      for (const sId of peerSocketIds) {
        io.to(sId).emit(CallEvent.CALL_OFFER, payload)
      }
    } catch (err) {
      console.error('[call:offer] error:', err)
      emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Failed to relay offer')
    }
  })

  // ----- call:answer -----
  socket.on(CallEvent.CALL_ANSWER, async (raw: any) => {
    try {
      const payload = safeParse<SDPPayload>(raw)
      if (!payload || typeof payload.conversationId !== 'string' || !payload.sdp) {
        return emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Invalid call:answer payload')
      }
      const call = getActiveCallByConversation(payload.conversationId)
      if (!call) {
        return emitError(socket, CallErrorCode.CALL_NOT_FOUND, 'Call not found', payload.conversationId)
      }
      if (call.receiverId !== userId) {
        return emitError(socket, CallErrorCode.NOT_ALLOWED, 'Only the receiver can send answer', payload.conversationId)
      }
      if (call.status !== CallStatus.CONNECTING && call.status !== CallStatus.CONNECTED) {
        return emitError(socket, CallErrorCode.NOT_ALLOWED, 'Call is not in connecting state', payload.conversationId)
      }

      const updated = updateCallStatus(call.conversationId, CallStatus.CONNECTED)

      // relay tới caller
      const peerSocketIds = getPeerSocketIds(call, userId)
      for (const sId of peerSocketIds) {
        io.to(sId).emit(CallEvent.CALL_ANSWER, payload)
      }

      // Nếu answer được relay thành công, đánh dấu connected (phía server không xử lý media, chỉ là trạng thái)
      // Phía caller sẽ chuyển state CONNECTED khi nhận được answer.
      void updated
    } catch (err) {
      console.error('[call:answer] error:', err)
      emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Failed to relay answer')
    }
  })

  // ----- call:ice -----
  socket.on(CallEvent.CALL_ICE, async (raw: any) => {
    try {
      const payload = safeParse<IcePayload>(raw)
      if (!payload || typeof payload.conversationId !== 'string' || !payload.candidate) {
        return emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Invalid call:ice payload')
      }
      const call = getActiveCallByConversation(payload.conversationId)
      if (!call) {
        return emitError(socket, CallErrorCode.CALL_NOT_FOUND, 'Call not found', payload.conversationId)
      }
      if (call.callerId !== userId && call.receiverId !== userId) {
        return emitError(socket, CallErrorCode.NOT_ALLOWED, 'Not a participant', payload.conversationId)
      }
      if (call.status === CallStatus.CALLING || call.status === CallStatus.ENDED) {
        return // không relay nếu call chưa tới CONNECTING hoặc đã ENDED
      }

      const peerSocketIds = getPeerSocketIds(call, userId)
      for (const sId of peerSocketIds) {
        io.to(sId).emit(CallEvent.CALL_ICE, payload)
      }
    } catch (err) {
      console.error('[call:ice] error:', err)
      emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Failed to relay ICE')
    }
  })

  // ----- call:end -----
  socket.on(CallEvent.CALL_END, async (raw: any) => {
    try {
      const payload = safeParse<EndPayload | CallPayload>(raw)
      if (!payload || typeof (payload as EndPayload).conversationId !== 'string') {
        return emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Invalid call:end payload')
      }
      const conversationId = (payload as EndPayload).conversationId
      const call = getActiveCallByConversation(conversationId)
      if (!call) {
        // call có thể đã được cleanup từ timeout/disconnect; báo cho client biết idempotent
        socket.emit(CallEvent.CALL_ENDED, { conversationId, reason: 'Call already ended' } satisfies EndPayload & {
          reason?: string
        })
        return
      }
      if (call.callerId !== userId && call.receiverId !== userId) {
        return emitError(socket, CallErrorCode.NOT_ALLOWED, 'Not a participant', conversationId)
      }

      // relay ended cho peer
      const peerId = getPeerUserId(call, userId)
      if (peerId) {
        const peerSocketIds = getSocketIds(peerId)
        for (const sId of peerSocketIds) {
          io.to(sId).emit(CallEvent.CALL_ENDED, { conversationId, reason: 'Peer ended call' } satisfies EndPayload & {
            reason?: string
          })
        }
      }
      removeCall(conversationId)
    } catch (err) {
      console.error('[call:end] error:', err)
      emitError(socket, CallErrorCode.BAD_PAYLOAD, 'Failed to end call')
    }
  })
}

export { RINGING_TIMEOUT_MS }
