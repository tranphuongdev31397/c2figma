# Runtime self-learning fallback — design

## Vấn đề

Engine hiện tại (`web/scene-capture.js`, `src/bridge-code.js`) parse DOM và convert
sang Figma node bằng heuristic tuned theo 2 fixture (employee/warehouse). HTML
lệch khỏi format quen thuộc dễ bị render sai ở 4 nhóm: thiếu element/bị bỏ qua,
state/tương tác không bắt được, style/font map sai, layout/position sai.

Mục tiêu: engine "học" từ những lần rơi vào xử lý generic, để lần sau gặp cấu
trúc tương tự thì xử lý đúng hơn — không cần sửa code thủ công mỗi lần.

## Phạm vi & giả định

- Chỉ nhắm engine chạy tại **runtime** (client JS trong plugin Figma + web app),
  không phải quy trình dev thu thập lỗi rồi Claude Code sửa code sau.
- Rule học được **share real-time giữa mọi user** qua 1 backend chung — không
  phải chỉ lưu local từng máy.
- Rule mới **tự động áp dụng ngay** cho mọi người, không qua hàng đợi duyệt.
  Rủi ro chấp nhận: 1 rule sai có thể lan ra trước khi bị phát hiện. Không có
  cơ chế rollback/confidence-decay ở version này.
- Không dùng LLM trong luồng runtime capture (giữ pure JS, quyết định đã chốt
  khi brainstorm — client engine bắt buộc chạy trong sandbox trình duyệt/Figma,
  không gọi model tại bước này).
- Không migrate JS hiện tại sang TypeScript trong scope này — việc tách biệt,
  làm sau nếu cần.

## Kiến trúc

### 1. Detection layer — tái dùng nhánh fallback sẵn có

Các nhánh generic/else đang tồn tại trong code là tín hiệu "gặp mẫu lạ", không
cần xây detector riêng:

- `web/scene-capture.js:133` — label fallback (không có aria-label/data-name
  → lấy className đầu tiên).
- `web/scene-capture.js:404-408` — modal/backdrop detect bằng
  `class*close*/backdrop*/overlay*`, không match thì rơi generic.
- Nhánh style/font không map được (font-family lạ, gradient/filter/clip-path
  engine chưa parse).

Mỗi lần code chạy vào 1 nhánh này, bắn 1 sự kiện `hit-fallback` gồm:

- `fallbackKind` — nhãn nhánh đã rơi vào (`label-fallback`, `modal-close-detect`,
  `font-map`, …).
- `signature` — cấu trúc rút gọn: `tag + role/aria attrs + shape của class`
  (KHÔNG chứa text/nội dung cụ thể, để rule không quá hẹp cho 1 mẫu).
- `context` — property/selector liên quan ngắn gọn (vd font-family value,
  selector không match).

### 2. Rule schema & backend

Backend: **Python (FastAPI)**, deploy độc lập với frontend Vercel (gọi qua URL
tuyệt đối, không chung platform).

- Store: **Redis chuẩn** qua `redis-py`, kết nối bằng env var `REDIS_URL`.
  Chạy Upstash/Vercel KV Redis-compatible endpoint hôm nay; chuyển VPS tự host
  Redis sau này chỉ đổi `REDIS_URL`, code không đổi.
- Validate: `pydantic`.
- Rule record (value trong Redis, key = `signature`):

```json
{
  "signature": "dialog|role=dialog|class:*modal*",
  "fallbackKind": "modal-close-detect",
  "resolution": { "...": "nhánh xử lý cụ thể engine nên dùng" },
  "hitCount": 1,
  "firstSeen": "...",
  "lastSeen": "..."
}
```

- Endpoint:
  - `GET /rules?signatures=sig1,sig2,...` — đọc batch theo danh sách signature.
  - `POST /rules` — ghi rule mới hoặc tăng `hitCount` nếu signature đã tồn tại.
- Không có bước duyệt/pending — request ghi được áp dụng ngay, public (ai cũng
  ghi được).

### 3. Runtime consumption flow

1. Đầu phiên capture 1 HTML, quét nhẹ toàn bộ DOM, sinh trước danh sách
   signature khả dĩ (tag+role+class-shape của mọi element).
2. Gọi `GET /rules` **1 lần duy nhất** theo batch signature đó — không gọi API
   theo từng element riêng lẻ.
3. Cache kết quả trong biến của phiên chạy (không cần localStorage — dùng
   1 lần cho phiên đó).
4. Khi xử lý 1 element: tra cache trước.
   - Có rule khớp signature → áp `resolution` đã lưu, bỏ qua nhánh generic gốc.
   - Không khớp → chạy nhánh generic như hiện tại **và** bắn `hit-fallback`
     → `POST /rules` ghi/update signature đó.
5. Plugin Figma: thêm domain của backend vào `networkAccess` trong
   `manifest.json` để được phép gọi request ra ngoài.

### 4. Error handling & giới hạn

- API lỗi/timeout (mất mạng, backend down) → bỏ qua lookup, chạy fallback
  generic gốc như hiện tại. Không block/crash luồng capture.
- Không rollback, không giảm ưu tiên rule theo thời gian — rule ghi 1 lần dùng
  mãi, chỉ tăng `hitCount` khi match lại.
- Không giới hạn quyền ghi — rủi ro rule sai lan ra được chấp nhận ở version
  này để ưu tiên tốc độ/đơn giản.

### 5. Testing

- `npm test` (node --test) thêm test cho:
  - Hàm match/apply rule tách thuần (input: signature + rule map, output:
    resolution) — test không phụ thuộc DOM/browser thật.
  - Fallback đúng khi cache miss hoặc API lỗi.
- Backend Python: test riêng cho `GET/POST /rules` (pytest), không phụ thuộc
  engine JS.

## Ngoài phạm vi (có thể làm sau, không phải bây giờ)

- Cơ chế duyệt rule / rollback / confidence-decay.
- Gọi LLM để synthesize resolution cho pattern hoàn toàn mới thay vì chỉ ghi
  nhận nhánh generic đã chạy.
- Migrate `src/*.js`, `web/*.js` sang TypeScript.
- Phân tích offline tập `hit-fallback` tích lũy để tự sinh heuristic mới
  (hướng "AI project" nếu backend Python được mở rộng thêm).
