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

`src/bridge-code.js` (renderer của path "Direct import" — path khuyến nghị
theo README) đã có sẵn 3 điểm `issues.push(...)` khi convert `scene.nodes`
sang Figma node. Đây là tripwire thật, không cần xây detector riêng:

- `bridge-code.js:114-120` — `figma.createNodeFromSvg` throw → issue kind
  `'svg'`, dùng placeholder frame rỗng thay layer.
- `bridge-code.js:142` — Figma âm thầm bỏ 1 fill hợp lệ về mặt cú pháp
  (`node.fills` rỗng sau khi gán) → issue kind `'fill'`.
- `bridge-code.js:164-166` — catch chung quanh toàn bộ thân xử lý 1 node
  (text/frame setup, resize, stroke, corner radius...) → mọi lỗi khác
  (bao gồm layout/position) rơi vào đây, issue kind = `item.kind`.

Mỗi lần 1 trong 3 điểm này chạy, bắn 1 sự kiện `hit-fallback` gồm:

- `fallbackKind` — `'svg-render-failed'` | `'fill-dropped'` | `'node-render-failed'`.
- `signature` — cấu trúc rút gọn từ `item` (scene node đã capture, không phải
  DOM sống): `item.kind + shape của item.name (bỏ số thứ tự cuối) + các cờ
  boolean liên quan (có border/radius/svg...)`. KHÔNG chứa `item.text` hay
  nội dung cụ thể, để rule không quá hẹp cho 1 mẫu.
- `context` — `error.message` ngắn gọn (đã có sẵn trong `issues.push`).

**Ngoài phạm vi v1** (ghi nhận nhưng không tự sửa hành vi): fallback shape-detect
modal/backdrop trong `web/scene-capture.js` (dismissers/`resetToBaseline`,
dòng ~419-463) — tín hiệu ở đây là per-page (`degraded: true` / sự kiện
`reuse-degraded`), không map gọn sang 1 signature per-node như trên. Việc này
để lại cho vòng sau.

**Phạm vi 1 renderer, không phải 3**: logic render bị lặp gần giống hệt ở
`src/bridge-code.js`, `web/plugin-code.js` (no-command web flow), và
`src/template.js` (CLI fallback) — `test/renderer.test.js` hiện assert cùng
pattern trên cả 3 file. v1 chỉ thêm hook vào `bridge-code.js` (path khuyến
nghị, dùng nhiều nhất). `web/plugin-code.js`/`template.js` không đổi trong
v1 — đồng bộ hoá 3 bản (hoặc dedupe hẳn) là việc riêng, không phải của spec
này.

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
  "signature": "fill|alphaOutOfRange:true|hasExtraFields:false",
  "fallbackKind": "fill-dropped",
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

`bridge-code.js` chạy trong Figma plugin sandbox (main thread `code.js`), xử
lý `scene.nodes` — mảng đã serialize sẵn, không phải DOM sống, nên không cần
bước "quét DOM" riêng:

1. Đầu `renderScene(scene, ...)`, trước vòng lặp `scene.nodes`, build sẵn
   danh sách signature từ chính `scene.nodes` (đã có trong tay, đồng bộ).
2. Gọi `GET /rules?signatures=...` **1 lần duy nhất** cho cả danh sách đó —
   không gọi API theo từng node riêng lẻ.
3. Cache kết quả trong 1 `Map` cục bộ của lần gọi `renderScene` đó (không cần
   localStorage/clientStorage — dùng 1 lần cho phiên import này).
4. Khi xử lý 1 node trong vòng lặp: tra cache trước.
   - Có rule khớp signature, `fallbackKind` = `'svg-render-failed'` hoặc
     `'fill-dropped'` → áp thẳng xử lý cố định tương ứng (xem Section 3b),
     bỏ qua đường đi mặc định sẽ throw/bị Figma bỏ fill.
   - Không khớp, hoặc `fallbackKind` = `'node-render-failed'` (v1 chưa có
     resolution tự động — xem "Ngoài phạm vi" ở Section 1) → chạy nhánh gốc
     như hiện tại; nếu nó vẫn rơi vào 1 trong 3 `issues.push`, bắn
     `hit-fallback` → `POST /rules` ghi/update signature đó.
5. Plugin Figma: đổi `networkAccess` trong `src/plugin-bundle.js` (hiện
   `{ allowedDomains: ['none'] }`) thêm domain của backend, để `fetch` từ
   `code.js` được phép gọi ra ngoài.

### 3b. Xử lý cố định theo fallbackKind — "học" là nhớ SIGNATURE nào cần nó

Bản thân cách xử lý cho 2 fallbackKind dưới đây là **cố định, không đổi theo
signature** — backend không lưu "resolution", chỉ lưu `signature → fallbackKind`
đã từng khớp. Phần "học" nằm ở chỗ: signature nào (gặp ở bất kỳ HTML/user nào)
đã biết trước sẽ rơi vào nhánh nào, để bỏ qua bước thử-rồi-thất-bại và áp
thẳng xử lý tương ứng — không phải học ra 1 cách sửa mới.

- **`fill-dropped`**: rule khớp → clamp `item.fill` trước khi gán (thay vì gán
  thẳng như `bridge-code.js:140` hiện tại) — ép `opacity` về đúng khoảng
  `[0, 1]` và bỏ mọi field ngoài `{r,g,b,a}`. Đây là nguyên nhân phổ biến
  khiến Figma âm thầm bỏ fill.
- **`svg-render-failed`**: rule khớp → bỏ qua hẳn lệnh gọi
  `figma.createNodeFromSvg` (đã biết trước sẽ throw), tạo placeholder frame
  ngay — tránh 1 exception vô ích, không đổi kết quả hình ảnh so với nhánh
  catch hiện tại.
- **`node-render-failed`** (generic catch): v1 chỉ ghi nhận (POST) để tích
  luỹ dữ liệu cho phân tích sau này — v1 không tự động hiển thị hitCount ở
  đâu cả, không tự đổi hành vi — lỗi ở đây quá đa dạng (resize, stroke,
  corner radius...) để suy ra 1 fix chung an toàn.

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
