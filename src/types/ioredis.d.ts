import 'ioredis'

/**
 * Khai báo type cho các Redis custom command (Lua script) được định nghĩa qua
 * `redis.defineCommand(...)`.
 *
 * ioredis gắn động method lên instance tại runtime nên TypeScript không tự biết.
 * Module augmentation ở đây giúp code gọi `connection.flushUnreadBuffer(...)` có type.
 */
declare module 'ioredis' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface RedisCommander<Context> {
    /**
     * Đọc toàn bộ buffer + xoá atomic bằng Lua script.
     * Trả về mảng JSON string của các event (rỗng nếu buffer không có gì).
     */
    flushUnreadBuffer(key: string): Promise<string[]>

    /**
     * Biến thể dùng cho test so sánh (script flush atomic tổng quát).
     */
    flushAtomic(key: string): Promise<string[]>
  }
}
