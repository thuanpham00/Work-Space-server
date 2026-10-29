import type { Server } from 'socket.io'

// định nghĩa instance của socket.io
let ioInstance: Server | null = null

// Resolve khi io đã sẵn sàng (adapter đã attach + connection handler đã đăng ký)
let resolveReady: (() => void) | null = null
let readyPromise: Promise<void> | null = null

/**
 * Được gọi sau khi io đã init xong (sau initRedisAdapter).
 */
export const setIO = (io: Server) => {
  ioInstance = io
  resolveReady?.()
  resolveReady = null
}

export const getIO = (): Server | null => ioInstance

/**
 * Chờ io sẵn sàng.
 * Dùng cho worker/queue: emit trước khi adapter attach sẽ chỉ đi local
 * → các instance khác không nhận được → mất badge vĩnh viễn.
 */
export const waitForIO = (timeoutMs = 30_000): Promise<Server> => {
  if (ioInstance) return Promise.resolve(ioInstance)

  if (!readyPromise) {
    readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
  }

  // Capture vào biến cục bộ: TS không narrow được biến module-scope bên trong closure
  const pending = readyPromise

  return new Promise<Server>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[socket-instance] Timeout ${timeoutMs}ms waiting for io`))
    }, timeoutMs)

    // unref: timer không giữ process sống
    if (typeof timer.unref === 'function') timer.unref()

    pending
      .then(() => {
        clearTimeout(timer)
        if (!ioInstance) throw new Error('IO ready but instance is null')
        resolve(ioInstance)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}
