# Hướng dẫn triển khai Redis theo từng Phase

> **Học qua code, làm theo thứ tự.** Mỗi phase có file riêng, đi kèm lý thuyết tối thiểu + code + giải thích.

## 📋 Mục lục các phase

| # | Phase | Mục tiêu | Thời gian | Trạng thái |
|---|-------|----------|-----------|------------|
| 0 | [Chuẩn bị môi trường](./phase-00-setup.md) | Cài Redis + package Node | 10 phút | ⏳ Bắt đầu từ đây |
| 1 | [Cache channel members](./phase-01-cache-members.md) | Bỏ 1 query DB (findMany channelMember) | 30 phút | 🔒 |
| 2 | [Cache workspace của channel](./phase-02-cache-workspace.md) | Bỏ query thứ 2 (findUnique channel) | 15 phút | 🔒 |
| 3 | [Parallel emit](./phase-03-parallel-emit.md) | Loop tuần tự → song song với Promise.all | 15 phút | 🔒 |
| 4 | [Redis adapter cho Socket.IO](./phase-04-redis-adapter.md) | Scale được 2+ Node instance | 30 phút | 🔒 |
| 5 | [Presence với Sorted Set](./phase-05-presence-sorted-set.md) | Restart không mất online state | 30 phút | 🔒 |
| 6 | [BullMQ - Queue + Worker](./phase-06-bullmq-worker.md) | Tách việc nặng khỏi main flow | 1 giờ | 🔒 |
| 7 | [Aggregator - Buffer trước Queue](./phase-07-aggregator.md) | 100 message → 1 job | 30 phút | 🔒 |
| 8 | [Pub/Sub cross-instance notify](./phase-08-pubsub-notify.md) | Broadcast unread tới nhiều instance | 20 phút | 🔒 |
| 9 | [Tổng hợp & kiểm thử](./phase-09-test-verify.md) | Verify toàn bộ pipeline | 1 giờ | 🔒 |

## 🗂️ Tài liệu liên quan

- [`../socket-current-architecture.md`](../socket-current-architecture.md) — Mô tả hiện trạng + nhược điểm
- [`../redis-realtime-optimization.md`](../redis-realtime-optimization.md) — Full code + lý thuyết nâng cao
- [`../redis-solution-theory.md`](../redis-solution-theory.md) — Pure lý thuyết distributed systems

## 💡 Cách dùng thư mục này

1. **Bắt đầu từ [Phase 0](./phase-00-setup.md)** — cài Redis + ioredis
2. **Mỗi phase có format thống nhất:**
   - 🎯 Mục tiêu
   - 📚 Lý thuyết tối thiểu
   - 💻 Code + giải thích
   - ✅ Checkpoint (test gì để biết OK)
   - 🐛 Lỗi thường gặp
3. **Làm xong → mở phase tiếp theo.** Không cần đọc hết 1 lần.

## 📊 Kết quả sau 9 phase

| Metric | Trước | Sau |
|--------|-------|-----|
| DB query / message | 4 | 1 |
| Main flow latency | ~250ms | ~15ms |
| Scale ngang | ❌ | ✅ |
| Restart safety | ❌ | ✅ |
| Unread processing | Tuần tự | Async batched |

## ⏱️ Tổng thời gian

- Triển khai: ~5 giờ
- Test + monitoring: +2 giờ
- Tổng: ~1 ngày làm việc
