/**
 * In-memory presence map: userId (string) -> Set<socketId>.
 * Một user có thể mở nhiều tab/phiên (nhiều socket), tất cả đều được track.
 * Cleanup theo socketId để không xóa nhầm các socket còn lại của cùng user.
 *
 * Lưu ý vận hành: chỉ phù hợp với một Node instance. Khi scale nhiều instance
 * cần thay bằng Redis adapter + shared state.
 */

type SocketId = string
type UserId = string

const userSockets = new Map<UserId, Set<SocketId>>()
const socketToUser = new Map<SocketId, UserId>()

export const addSocket = (userId: UserId, socketId: SocketId): void => {
  socketToUser.set(socketId, userId)
  const set = userSockets.get(userId)
  if (set) {
    set.add(socketId)
  } else {
    userSockets.set(userId, new Set([socketId]))
  }
}

export const removeSocket = (socketId: SocketId): UserId | null => {
  const userId = socketToUser.get(socketId)
  if (!userId) return null

  socketToUser.delete(socketId)
  const set = userSockets.get(userId)
  if (set) {
    set.delete(socketId)
    if (set.size === 0) {
      userSockets.delete(userId)
    }
  }
  return userId
}

export const getSocketIds = (userId: UserId): SocketId[] => {
  const set = userSockets.get(userId)
  return set ? Array.from(set) : []
}
