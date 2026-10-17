# Phase 0: Chuẩn bị môi trường

> ⏱️ **Thời gian:** 10 phút
> 🎯 **Mục tiêu:** Redis chạy được trên máy + Node.js kết nối được

---

## 📚 Lý thuyết tối thiểu

**Redis là gì?**

Redis là **in-memory key-value store** — lưu data trong RAM (rất nhanh, ~0.1ms truy cập) thay vì disk.

Khác với MySQL/PostgreSQL:
- MySQL: lưu table, query SQL, hỗ trợ JOIN
- Redis: lưu key-value đơn giản, không query, cực nhanh

**Khi nào dùng Redis?**
- Cache (giảm tải DB)
- Pub/Sub (broadcast real-time)
- Queue (BullMQ)
- Counter, lock, session

**Trong project này:** Dùng cả 4.

---

## Bước 1: Chạy Redis server

Chọn 1 trong 3 cách:

### Cách A: Docker (khuyến nghị nhất)

```bash
docker run -d --name chat-redis -p 6379:6379 redis:7-alpine
```

Kiểm tra:
```bash
docker ps
# → thấy container chat-redis STATUS "Up"
```

Dừng Redis:
```bash
docker stop chat-redis
```

Khởi động lại:
```bash
docker start chat-redis
```

Xoá Redis (xoá luôn data):
```bash
docker rm -f chat-redis
```

### Cách B: WSL2 (Linux subsystem)

```bash
wsl
sudo apt update
sudo apt install redis-server
redis-server --daemonize yes
```

### Cách C: Native Windows

Tải từ: https://github.com/microsoftarchive/redis/releases

Giải nén → chạy `redis-server.exe`.

---

## Bước 2: Test bằng redis-cli

```bash
docker exec -it chat-redis redis-cli
```

Trong shell redis-cli, gõ:

```redis
PING
```

Kết quả: `PONG` ← Redis đang chạy OK.

```redis
SET greeting "hello world"
GET greeting
```

Kết quả: `"hello world"`

```redis
DEL greeting
GET greeting
```

Kết quả: `(nil)` (xoá rồi nên không có).

```redis
EXIT
```

Thoát.

---

## Bước 3: Cài package Node

Mở terminal ở thư mục project:

```bash
cd "d:/VS_CODE/Project/Project-Fullstack/WorkSpace/server"
npm install ioredis
```

`ioredis` là thư viện Redis client phổ biến nhất cho Node.js.

---

## Bước 4: Cấu hình biến môi trường

Mở file `.env` ở root project, thêm dòng:

```bash
REDIS_URL=redis://localhost:6379
```

Nếu Redis có password:
```bash
REDIS_URL=redis://:password@localhost:6379
```

Nếu Redis chạy ở server khác:
```bash
REDIS_URL=redis://192.168.1.100:6379
```

---

## ✅ Checkpoint Phase 0

- [ ] `docker ps` thấy container `chat-redis` đang chạy
- [ ] `docker exec -it chat-redis redis-cli PING` trả về `PONG`
- [ ] `npm list ioredis` thấy package
- [ ] File `.env` có dòng `REDIS_URL=...`

### Test cuối cùng: Kết nối từ Node

Tạo file test tạm `test-redis.js` ở root project:

```javascript
require('dotenv').config()
const Redis = require('ioredis')

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

async function main() {
  await redis.set('test:phase0', 'hello')
  const value = await redis.get('test:phase0')
  console.log('Read from Redis:', value)
  await redis.del('test:phase0')
  await redis.quit()
}

main().catch(console.error)
```

Chạy:
```bash
node test-redis.js
```

Kết quả mong đợi: `Read from Redis: hello`

Sau khi test xong, **xoá file `test-redis.js`** (chỉ dùng để verify).

---

## 🐛 Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|-----|-------------|----------|
| `ECONNREFUSED 127.0.0.1:6379` | Redis chưa chạy | `docker ps` kiểm tra, `docker start chat-redis` |
| `NOAUTH Authentication required` | Redis có password | Sửa URL: `redis://:password@host:6379` |
| `Cannot find module 'ioredis'` | Chưa cài package | `npm install ioredis` |
| `docker: command not found` | Chưa cài Docker | Dùng WSL2 hoặc native Windows |

---

## ⏭️ Phase tiếp theo

**[Phase 1: Cache channel members →](./phase-01-cache-members.md)**
