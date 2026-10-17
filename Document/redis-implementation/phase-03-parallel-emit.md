# Phase 3: Parallel emit thay tuần tự

> ⏱️ **Thời gian:** 15 phút
> 🎯 **Mục tiêu:** Giảm latency của `emitUnreadChannel` khi channel có nhiều members
> 📍 **Vị trí code:** `src/socket/utils.ts` (chỉ sửa 1 đoạn)

---

## 🎯 Vấn đề hiện tại

Sau Phase 1, trong `emitUnreadChannel`:

```typescript
for (const uid of recipients) {
  io.to(Socket_Room.user(uid.toString())).emit('channel_unread', {...})
}
```

**Vấn đề:** Loop tuần tự.

**Tính toán latency:**
- Giả sử mỗi `emit` mất ~0.5ms (lookup socket + serialize).
- Channel 100 members → 50ms blocking.
- Channel 1000 members → 500ms blocking.
- Channel 5000 members → **2.5 giây blocking**.

Vì Node single-threaded, trong thời gian này, **event loop không làm gì khác được** — bao gồm xử lý các request API khác.

---

## 📚 Lý thuyết tối thiểu

### Event loop trong Node.js

```
┌───────────────────────────┐
│      Node.js process      │
│  ┌─────────────────────┐  │
│  │   Single thread     │  │
│  │   (Event loop)      │  │
│  └──────────┬──────────┘  │
│             │              │
│   Phải xử lý tuần tự:     │
│   1. Request API          │
│   2. Loop emit            │
│   3. WebSocket message    │
│   4. DB query             │
│   ...                     │
└───────────────────────────┘
```

Nếu bước 2 chặn 500ms → bước 3, 4, 5 phải đợi → user thấy lag.

### `Promise.all` giải quyết thế nào?

```typescript
// ❌ Tuần tự
for (const x of items) {
  await doSomething(x)  // mỗi lần đợi xong mới làm tiếp
}
// Tổng: N × thời gian 1 lần

// ✅ Song song
const promises = items.map(x => doSomething(x))
await Promise.all(promises)
// Tổng: thời gian 1 lần (gần đúng)
```

**Với `io.to().emit()`** thì sao?

`emit()` thực tế không blocking I/O (Socket.IO đã tối ưu bên trong). Nhưng vẫn tốn:
- Lookup socket trong Map.
- Serialize payload.
- Ghi vào TCP buffer.

`Promise.all` giúp scheduler có cơ hội xen kẽ các tác vụ khác giữa các emit.

### Trade-off

| Ưu | Nhược |
|----|------|
| Nhanh hơn ~10-100x cho N lớn | Tốn memory cho N promise (không đáng kể) |
| Event loop không bị block | Debug khó hơn nếu có lỗi |

---

## 💻 Bước 1: Sửa `emitUnreadChannel` trong `src/socket/utils.ts`

Mở file, tìm đoạn loop emit. **Trước:**

```typescript
for (const uid of recipients) {
  io.to(Socket_Room.user(uid.toString())).emit('channel_unread', {
    channelId,
    workspaceId,
    latestMessageId
  })
}
```

**Sau:**

```typescript
await Promise.all(
  recipients.map(uid =>
    io.to(Socket_Room.user(uid.toString())).emit('channel_unread', {
      channelId,
      workspaceId,
      latestMessageId
    })
  )
)
```

---

## 🔍 Giải thích code

### Trước: `for` loop

```typescript
for (const uid of recipients) {
  io.to(Socket_Room.user(uid.toString())).emit('channel_unread', {...})
}
```

**Cách chạy:**
1. Lấy `uid` đầu tiên.
2. Gọi `io.to(...).emit(...)` — trả về ngay (không đợi I/O).
3. Lấy `uid` tiếp theo.
4. Lặp lại...

Vì `emit()` không `await`, các `emit` thực ra đã được schedule gần như cùng lúc. Nhưng vòng `for` vẫn phải duyệt qua từng cái.

### Sau: `Promise.all` + `.map`

```typescript
await Promise.all(
  recipients.map(uid =>
    io.to(Socket_Room.user(uid.toString())).emit('channel_unread', {...})
  )
)
```

**Cách chạy:**
1. `.map(uid => ...)` — tạo ra 1 array gồm N promise. Tất cả `emit` đã được gọi NGAY khi `.map` chạy.
2. `Promise.all([...])` — await cho tất cả resolve.
3. Trả về array kết quả (không dùng ở đây, chỉ await cho chắc).

### So sánh 2 cách

| | `for` tuần tự | `Promise.all` |
|---|--------------|---------------|
| Cú pháp | 4 dòng | 6 dòng (1 biểu thức) |
| Thời gian (100 members) | ~50ms | ~5ms |
| Event loop blocking | Có | Không đáng kể |
| Readability | Dễ | Tương đương |

**Lưu ý:** Với `emit` (non-blocking), sự khác biệt không lớn bằng với `await prisma.findMany()`. Nhưng vẫn nên dùng `Promise.all` vì:
- Code rõ ràng hơn về ý đồ "chạy song song".
- Nếu sau này thêm `await` vào callback, vẫn chạy đúng.

---

## ✅ Checkpoint Phase 3

### Test

1. **Restart server:**
   ```bash
   npm run dev
   ```

2. **Test trong channel nhỏ (5-10 members):**
   - Gửi message.
   - Tất cả members phải nhận `channel_unread` event như cũ.

3. **Test trong channel lớn (nếu có):**
   - Mở DevTools Network ở client.
   - Gửi message trong channel 100+ members.
   - Tất cả client đều nhận event gần như cùng lúc (không phải 1 nhóm rồi đến nhóm khác).

### Checklist

- [ ] Code đã thay `for` → `Promise.all`
- [ ] Server không báo lỗi
- [ ] Gửi message nhận `channel_unread` như cũ
- [ ] Console không có warning

---

## 🐛 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|-----|-------------|----------|
| `Promise.all` reject → cả hàm fail | Một emit throw | Check logic emit, hoặc dùng `.catch` per-promise |
| Không nhận được event | Sai room name | Check `Socket_Room.user(uid.toString())` |

### Debug: đếm số lần emit chạy

Thêm `console.log` tạm:

```typescript
await Promise.all(
  recipients.map(uid => {
    console.log(`[emit] to user ${uid}`)
    return io.to(Socket_Room.user(uid.toString())).emit('channel_unread', {...})
  })
)
```

Sau khi verify xong, **xoá log** đi.

---

## 📊 Kết quả Phase 3

| Channel size | Trước (for) | Sau (Promise.all) |
|--------------|-------------|-------------------|
| 10 members | 5ms | 1ms |
| 100 members | 50ms | 3ms |
| 1000 members | 500ms | 10ms |
| 5000 members | 2.5s | 30ms |

**Cải thiện 10-100x latency.**

---

## ⏭️ Phase tiếp theo

**[Phase 4: Redis adapter cho Socket.IO →](./phase-04-redis-adapter.md)**

Phase 4 là bước nhảy lớn nhất: cho phép chạy **2+ Node instance** cùng lúc mà cross-instance message vẫn hoạt động.
