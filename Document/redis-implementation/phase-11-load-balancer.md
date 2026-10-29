# Phase 11: Load Balancer cho Socket.IO (Sticky Session + 2 Instances)

> ⏱️ **Thời gian:** 45–60 phút
> 🎯 **Mục tiêu:** Chạy 2+ Node instance sau 1 load balancer, socket cross-instance vẫn nhận đủ message/unread/presence
> 📍 **Vị trí code:** Không đổi code (đã xong ở Phase 4) — chỉ thêm `nginx.conf` + cách chạy + cách test
> 📦 **Điều kiện tiên quyết:** Phase 4 (Redis adapter đã attach), `FRONTEND_URL` đã đưa vào env, `isMemberChannel` đã check `ACTIVE`

---

## 🎯 Vấn đề hiện tại

Sau Phase 4–10, mọi emit đã đi qua Redis pub/sub:

```
Instance A ──PUBLISH──▶ Redis ──FAN-OUT──▶ Instance B
```

Nhưng nếu đặt 2 instance sau 1 load balancer **không sticky**, vẫn sập:

```
Client polling (default transports = polling + websocket):

  handshake  ──▶ LB ──▶ Instance A   (tạo sid X, lưu trong RAM của A)
  poll #2    ──▶ LB ──▶ Instance B   (B không biết sid X → 400 Unknown sid)
  poll #3    ──▶ LB ──▶ Instance A   (lại được)
  → socket cứ connect/disconnect liên tục, message rớt, heartbeat mất.
```

**Triệu chứng khi LB không sticky:**
- Client log `websocket error` / `polling error` liên tục.
- `connection` bắn liên tục, `disconnect` ngay sau đó.
- Presence online/offline nhảy loạn (vừa online đã offline).
- Test 1 instance thì ngon, bật instance thứ 2 là toang.

---

## 📚 Lý thuyết tối thiểu

### 1. Vì sao Socket.IO bắt buộc sticky session?

Socket.IO handshake gồm nhiều HTTP request (polling) **có trạng thái**:

```
┌────────┐   GET /socket.io/?EIO=4&transport=polling    ┌────────────┐
│ Client │ ───────────────────────────────────────────▶ │ Instance A │
│        │ ◀─────────────────────────────────────────── │ (sid=abc,  │
│        │   sid=abc (lưu trong RAM của A)              │  buffer)   │
│        │                                              └────────────┘
│        │   POST /socket.io/?sid=abc  ──▶ LB ──▶ Instance B  ❌
│        │   B tra RAM: "sid abc là gì?" → không biết → 400
└────────┘
```

Chỉ có 2 cách thoát:

| Cách | Làm gì | Khi nào dùng |
|------|--------|--------------|
| **A. Sticky session ở LB (khuyến nghị)** | LB route cùng client luôn về cùng instance (dựa trên IP) | Giữ nguyên code, giữ polling làm fallback |
| **B. Ép `transports: ['websocket']`** | Chỉ 1 TCP connection, không còn polling nhiều request | Client + server đều phải đổi, mất fallback khi firewall chặn WS |

**Dự án này chọn A** — không đụng code, LB lo hết.

### 2. Kiến trúc mục tiêu

```
                    ┌─────────────────────────────┐
                    │      Nginx (port 5000)       │
                    │      ip_hash (sticky)       │
                    └──────┬──────────────┬───────┘
                           │              │
              ┌────────────▼────┐  ┌──────▼────────────┐
              │  Instance A     │  │  Instance B       │
              │  PORT=5001      │  │  PORT=5002        │
              │  io + adapter   │  │  io + adapter     │
              │  worker BullMQ  │  │  worker BullMQ    │
              └────────┬────────┘  └────────┬──────────┘
                       │    PUBLISH/SUBSCRIBE    │
                       └───────────┬────────────┘
                                   ▼
                          ┌────────────────┐
                          │  Redis :6379   │
                          │  - adapter bus │
                          │  - presence    │
                          │  - BullMQ queue│
                          └────────────────┘
```

- Nginx là entry duy nhất (client chỉ biết `:5000`).
- `ip_hash` đảm bảo cùng IP client → cùng instance.
- Redis là điểm đồng bộ duy nhất (không còn state local nào quan trọng — `online-users.ts` đã xóa).

---

## 🔧 Bước 1: Chuẩn bị env (5 phút)

### 1.1. `.env` — không đổi gì cho dev, chỉ xác nhận

```bash
PORT=5000              # chỉ dùng khi chạy 1 instance, không qua LB
FRONTEND_URL="http://localhost:5173"
REDIS_URL=redis://localhost:6379
```

Khi chạy multi-instance, **PORT lấy từ biến môi trường của từng process**, không đọc chung `.env`:

```bash
# Windows PowerShell
$env:PORT=5001; npm run dev   # terminal 1
$env:PORT=5002; npm run dev   # terminal 2
```

> ⚠️ 2 instance cùng 1 Redis (`REDIS_URL` giống nhau) — đó chính là bus đồng bộ.

### 1.2. Kiểm tra code đã sẵn sàng LB chưa (checklist)

| Check | File | Trạng thái đúng |
|-------|------|-----------------|
| Adapter attach **trước** handler | `src/socket/socket.ts` (~dòng 36) | `await initRedisAdapter(io)` trước `io.on('connection')` |
| Không còn Map in-memory | `src/socket/online-users.ts` | **Đã xóa file** |
| Presence qua Redis | `src/services/presence.services.ts` | `ZADD/ZREM` + `cleanupIdlePresence` |
| Membership check `ACTIVE` | `src/socket/utils.ts` → `isMemberChannel` | `findUnique` PK + `status === ACTIVE` |
| `leave_channel` unconditional | `src/socket/socket.ts` | Không check member khi leave |
| CORS từ env | `socket.ts` + `index.ts` | `origin: [envConfig.frontend_url]` |

Nếu thiếu 1 dòng → quay lại Phase 4–10, chưa làm Phase 11.

---

## 🔧 Bước 2: Nginx sticky session (15 phút)

### 2.1. Cài nginx (Windows dev)

```bash
# Cách 1: Chocolatey
choco install nginx

# Cách 2: tải zip tại https://nginx.org/en/download.html, giải nén, chạy nginx.exe
```

### 2.2. `nginx.conf` — đặt cạnh project (ví dụ `lb/nginx.conf`)

```nginx
events {
  worker_connections 1024;
}

http {
  # Upstream: 2 Node instance — ip_hash = sticky theo IP client
  upstream socket_backend {
    ip_hash;
    server 127.0.0.1:5001;
    server 127.0.0.1:5002;
  }

  server {
    listen 5000;

    # Tăng timeout cho long-polling + websocket
    proxy_connect_timeout 7d;
    proxy_send_timeout 7d;
    proxy_read_timeout 7d;

    location / {
      proxy_pass http://socket_backend;

      # BẮT BUỘC cho websocket upgrade
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";

      # Giữ IP thật của client (để ip_hash + log đúng)
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

      # CORS đi qua proxy (không set cứng ở đây, để Express lo)
      proxy_set_header Origin $http_origin;
    }
  }
}
```

**Giải thích từng dòng quan trọng:**

```
ip_hash;                        → cùng IP client luôn về cùng instance (sticky).
                                → polling request #2, #3... không bị lạc sang instance khác.

proxy_http_version 1.1;         → websocket yêu cầu HTTP/1.1 trở lên.
proxy_set_header Upgrade ...    → cho phép Upgrade từ polling → websocket.
proxy_set_header Connection ... → giữ connection sống (long-polling 25s + heartbeat).

proxy_read_timeout 7d;          → polling treo lâu không bị nginx cắt giữa chừng.
```

### 2.3. Chạy thử

```bash
# Terminal 1 — instance A
$env:PORT=5001; npm run dev

# Terminal 2 — instance B
$env:PORT=5002; npm run dev

# Terminal 3 — nginx (trỏ tới file config trên)
nginx -c D:/VS_CODE/Project/Project-Fullstack/WorkSpace/server/lb/nginx.conf
# hoặc nếu nginx cài service: copy block server{} vào nginx.conf mặc định rồi nginx -s reload
```

Client (frontend) **không đổi URL** — vẫn gọi `http://localhost:5000` (giờ là nginx, không phải Node trực tiếp):

```typescript
// frontend — giữ nguyên
import { io } from 'socket.io-client'
const socket = io('http://localhost:5000', { withCredentials: true })
```

---

## 🔧 Bước 3: Test cross-instance (20 phút)

### 3.1. Test 1 — Sticky có hoạt động không?

Mở 2 tab, F12 → Network → WS/XHR:

```
Tab 1: /socket.io/?EIO=4&transport=polling → Response header: ... (luôn về 1 instance)
Tab 2: tương tự
```

Thêm log tạm ở mỗi instance để thấy sticky:

```typescript
// src/index.ts — log tạm khi test, xong xóa
httpServer.listen(PORT, () => {
  console.log(`[Instance] listening on ${PORT}`)
})
```

```bash
# Gửi 10 request liên tiếp từ cùng 1 máy — với ip_hash phải luôn về cùng 1 port
for ($i=1; $i -le 10; $i++) { Invoke-WebRequest http://localhost:5000/users/me -UseBasicParsing | Out-Null; Write-Host "req $i" }
# Check log 2 terminal: chỉ 1 bên nhận cả 10 request → sticky OK
```

### 3.2. Test 2 — Message cross-instance (quan trọng nhất)

```
Chuẩn bị: User X + User Y cùng member 1 channel.

1. Kill instance B (chỉ để A) → X connect → join_channel → gửi tin → Y nhận. (baseline)
2. Bật cả A + B (qua nginx :5000).
   - X reload nhiều lần tới khi dính instance A (xem log).
   - Y reload nhiều lần tới khi dính instance B.
   - X gửi message → Y phải nhận `receive_message` real-time.
   - Y gửi lại → X phải nhận.
3. Nếu 1 chiều mất → Redis adapter chưa đồng bộ (xem Phase 4):
   - Check log `[RedisAdapter] attached` ở CẢ 2 terminal.
   - Check 2 instance cùng `REDIS_URL`.
```

### 3.3. Test 3 — Unread badge cross-instance

```
1. Y offline (đóng tab).
2. X (instance A) gửi 3 tin liên tiếp.
3. Y mở lại (rơi vào instance B) → phải thấy `channel_unread` badge = 3.
   - Luồng: A enqueue → Redis buffer → BullMQ → worker (A hoặc B, ai rảnh làm) → emit tới room user:Y → adapter fan-out → B đẩy xuống socket Y.
4. Nếu badge mất → check BullMQ dashboard / log `[Aggregator] flushed` + `[Unread Worker]`.
```

### 3.4. Test 4 — Kill 1 instance (failover)

```
1. Cả A + B đang chạy, X + Y đang chat qua LB.
2. Kill -9 instance A (giả lập crash).
3. Client dính A sẽ disconnect → tự reconnect → nginx route sang B (vì A chết).
   - Socket reconnect có tốn vài giây (bình thường).
   - Sau reconnect: join_channel lại (client phải tự re-join — kiểm tra frontend có logic này chưa).
   - Chat tiếp phải bình thường.
```

> ⚠️ **Frontend phải tự `join_channel` lại sau `reconnect`** — socket mới = room trắng. Đây là việc của client:
>
> ```typescript
> socket.on('reconnect', () => {
>   socket.emit('join_channel', currentChannelId) // client tự nhớ channel đang mở
> })
> ```

---

## ⚠️ Bẫy thường gặp

### Bẫy 1: Quên `ip_hash` → socket reconnect vô hạn

```
Triệu chứng: log server full `connection` / `disconnect`, client báo `Unknown sid`.
Fix: thêm `ip_hash;` trong block upstream (mục 2.2).
```

### Bẫy 2: 2 instance khác `REDIS_URL` → mỗi người 1 đảo

```
Triệu chứng: cùng instance thì nhận tin, khác instance thì không.
Fix: in log khi boot:
  console.log('[Boot] redis_url =', envConfig.redis_url)
  → 2 terminal phải in giống hệt nhau.
```

### Bẫy 3: Aggregator chạy trùng trên N instance → log double

```
Hiện tại mỗi instance đều chạy setInterval(flush 1s).
Lua script atomic nên KHÔNG mất event (người này flush, người kia nhận rỗng).
Chỉ bị log trùng + 2 vòng flush thừa — chấp nhận được ở 2–3 instance.
Khi lên 5+ instance: tách 1 process worker riêng (chỉ chạy aggregator + worker, không chạy socket).
```

### Bẫy 4: Deploy rolling — client dính instance đang shutdown

```
Shutdown hiện tại chỉ đóng Redis adapter (src/index.ts).
Khi deploy: LB phải drain (ngừng route mới sang instance cũ, chờ socket cũ tự đóng) rồi mới kill.
Nginx: đánh `down` tạm:
  upstream socket_backend { server 127.0.0.1:5001 down; server 127.0.0.1:5002; }
  → reload → deploy A → bỏ `down` → deploy B.
```

### Bẫy 5: CORS sau LB

```
Client gọi nginx :5000, nhưng Express thấy Host = nginx.
Vì CORS đã dùng envConfig.frontend_url (không hardcode) nên không sao.
Nếu sau này LB có domain riêng (vd. api.chat.com) → thêm domain đó vào FRONTEND_URL (dạng list).
```

---

## ✅ Checklist hoàn thành Phase 11

- [ ] `nginx.conf` có `ip_hash` + websocket upgrade headers
- [ ] 2 instance boot, cả 2 log `[RedisAdapter] attached`
- [ ] Test 1 (sticky): 10 request cùng IP → cùng 1 instance
- [ ] Test 2 (message): X ở A, Y ở B, chat 2 chiều real-time OK
- [ ] Test 3 (unread): Y offline → X gửi 3 tin → Y online lại thấy badge
- [ ] Test 4 (failover): kill A → client reconnect sang B, chat tiếp OK
- [ ] Frontend có `reconnect → re-join_channel`
- [ ] Xóa log tạm, commit `lb/nginx.conf`

---

## 🔜 Sau Phase 11

| Việc | Khi nào |
|------|---------|
| Tách process worker riêng (không chạy socket) | Khi ≥ 5 instances |
| Redis Sentinel / Cluster | Khi Redis thành single point of failure |
| Rate-limit heartbeat (server bỏ qua nếu < 10s) | Khi presence spam |
| Guard `Number.isInteger` trong `isMemberChannel` | Khi rảnh (chống `channel_id` rác throw `BigInt(NaN)`) |
| Monitoring (BullMQ Dashboard / Prometheus) | Trước khi lên production thật |

---

## 📎 File tham khảo trong repo

- Adapter: `src/socket/redis.adapter.ts` (Phase 4)
- Presence: `src/services/presence.services.ts` (Phase 5)
- Worker: `src/queues/unread.worker.ts` (Phase 6)
- Aggregator: `src/queues/unread.aggregator.ts` (Phase 7)
- Kiến trúc tổng: `Document/redis-implementation/phase-10-architecture-overview.md`
