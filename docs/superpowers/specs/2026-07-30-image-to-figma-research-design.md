# Image → Figma (Direction 2): Experimental Research Pipeline

**Date:** 2026-07-30
**Status:** Approved for planning

## Goal

Answer, with numbers, how close a vision-model-only pipeline (screenshot in,
no DOM access) can get to the existing HTML→Figma pipeline's quality. The
HTML pipeline's DOM-derived `scene.json` is treated as ground truth — this is
a research/benchmarking tool, not a product feature. Real target use case
(explicitly out of scope for this iteration): mockups, competitor app
screenshots, native-app screenshots — anywhere there is no HTML to capture.

## Non-goals for this iteration

- Not a replacement for the existing HTML capture pipeline. HTML capture
  stays primary whenever HTML is available (it reads the DOM directly — free
  ground truth for box/color/text; vision inference should never be used
  when DOM access exists).
- No web UI integration, no Figma plugin integration. Output is a standalone
  JSON file the existing plugin renderer can already consume, but wiring it
  into `web/index.html` or the Direct Import plugin is a separate follow-up
  decision, made after the numbers come back.
- No CV/image-segmentation layer (OpenCV, coordinate-snapping, edge
  detection). Decided against per the earlier design discussion: pixel-only
  geometry extraction is a CV problem with its own failure modes (contour
  noise, no semantic grouping), and this iteration's goal is to measure
  whether a vision LLM alone gets close enough that CV is even worth adding.
- No multi-tile / long-page handling. Images over 2576px on the long edge
  (OpenAI's high-res vision ceiling) are rejected with a clear error rather
  than silently resized (which would desync the model's coordinate frame
  from the real image).
- No `kind: 'image'` / raster-fill support in the wire format. Out of scope
  until there's a concrete need for it.

## Architecture

```
shot.png ──► src/image-scene.js ──► scene.json (wire format v1) ──► existing plugin renderer ──► Figma
                     │
                     ├─► src/providers/ollama.js   (local, free, qwen2.5vl:7b)
                     └─► src/providers/openai.js   (hosted, gpt-4o-mini / gpt-4o)

bench/fixtures/<case>/
  shot.png        — screenshot, manually captured
  truth.json      — DOM-derived scene.json, exported from web/index.html's existing ZIP output
  scene.*.json    — image-pipeline output, one per provider/model tried (gitignored, regenerable)

bench/compare.js  — scores scene.*.json against truth.json: IoU, color ΔE, text-match %
```

Three new directories: `src/providers/`, `bench/`, `.claude/skills/vision-scene-prompt/`
(the last already written — see below). Nothing in `web/`, `src/bridge-code.js`,
`src/plugin-bundle.js`, the manifest, or `backend/` changes.

## Why this shape (approaches considered)

Three architectures for the "bộ sinh" (generator) were discussed:

- **A. CV-first, LLM polish.** Segment via OpenCV contours + OCR, hand the box
  list to an LLM for grouping/naming. Rejected: contour noise on UI
  screenshots is severe (every hairline, every icon is a candidate), and the
  local CV venv (`.claude/finan-qc/ui-engine/`) isn't even present in this
  project — would need a fresh Python + Pillow/numpy install plus
  `pytesseract`, which isn't in that venv's dependency list either.
- **B. LLM-first, CV snap.** LLM proposes the full scene graph; CV then
  edge-snaps coordinates and re-samples colors from the actual pixels. Best
  long-term accuracy, but adds a CV dependency before knowing if plain LLM
  output is even close. Reserved as the natural next step if Approach C's
  numbers are bad specifically on geometry (not on grouping/naming).
- **C. LLM-only, no CV. — Chosen.** Model receives the raw image and a JSON
  Schema that mirrors the wire format; returns the full scene graph in one
  call. Cheapest to build, and because ground truth already exists
  (`truth.json` from the DOM pipeline), any weakness shows up immediately as
  a number instead of a guess. If geometry accuracy is the bottleneck,
  Approach B's CV-snap layer is the addressable next step — this iteration's
  job is to produce the evidence for that decision, not to build for it
  preemptively.

## Vision provider layer

Two providers for this iteration, both called via raw `fetch` (Node 24 has
global `fetch`) — **no new npm dependency**. This repo is deliberately
zero-dependency (`package.json` has none; CLAUDE.md states this explicitly),
and adding the official `openai` SDK package for one CLI script would break
that invariant for marginal convenience. `providers/ollama.js` and
`providers/openai.js` are ~30-line files with one exported function:

```js
// generate(imgBase64Data, { width, height, model, effort? }) → Promise<node[]>
```

| Provider | Model | Role | Cost |
|---|---|---|---|
| Ollama (local) | `qwen2.5vl:7b` | Iteration — prompt/schema tuning loop, unlimited free calls | $0 |
| OpenAI (hosted) | `gpt-4o-mini` → `gpt-4o` | Ceiling measurement — what's actually achievable | ~$0.01–0.02/img (mini), ~$0.05–0.15/img (4o); user has a $20 account, comfortably covers the full research loop |

Dispatch is a plain object map (`{ollama, openai}[provider]`), not a
factory/interface — adding a third provider later is one file plus one map
entry. Both request paths share the same `NODE_SCHEMA` (JSON Schema) to
constrain output: Ollama via its `format` field, OpenAI via
`response_format.json_schema` (`strict: true`).

**Remote Ollama (LAN/VPS) — deferred, not built now.** `--ollama-url` flag
defaults to `http://localhost:11434`; pointing it at a LAN IP or an SSH
tunnel to a VPS later requires zero code changes, only a flag value. Full
staged rollout plan (LAN → VPS via SSH tunnel, since Ollama has no built-in
auth) is documented in this design's discussion history but not implemented
— local-only for now.

## Prompt and schema

See `.claude/skills/vision-scene-prompt/SKILL.md` (already written) for the
full reasoning and the maintained copy of the current prompt/schema. Summary:

- **English instructions**, even though target screenshots are Vietnamese UI
  — instruction-following on the weak local model is more reliable in
  English, and this is a system prompt (not user-facing UI copy), so the
  project's "Vietnamese for user-facing strings" convention doesn't apply
  here.
- **MUST / NEVER phrasing**, short and flat (not deeply nested) — tuned for
  the weaker target (`qwen2.5vl:7b`); the stronger hosted model loses nothing
  from a short prompt.
- **JSON Schema carries the format contract**; the prompt only carries
  semantics the schema can't express (what `parentId` means, dominant-color
  picking, naming convention, grounding-against-fabrication rules).
- Fields the model is asked for: `id, parentId, kind, name, x, y, width,
  height, fill, stroke, strokeWidth, radius, text, fontSize, fontWeight,
  color`. Fields filled in by code afterward, not asked of the model:
  `version: 1`, `viewport` (read from the PNG's IHDR chunk), `opacity: 1`,
  `position: 'static'`, `zIndex: 'auto'`, `overflow: 'visible'`, `lines: 1`,
  `svg: null`, `borders: null`.
- `position: 'static'` means no node is ever hoisted to the root by the
  renderer's z-order logic (`stackLevel`/`compareStack` in
  `bridge-code.js`) — accepted as a known, measurable gap for this
  iteration: an image has no reliable z-index signal, and the benchmark will
  quantify how much this costs on screens with overlays/dropdowns.

## Benchmark: `bench/compare.js`

Ground truth acquisition is **manual, no new code**: `web/index.html`'s
existing ZIP output already includes a raw `scene.json`
([index.html:171](../../../web/index.html#L171)) — drop the same HTML file
in, download, unzip, copy `scene.json` to `truth.json`. Screenshot the same
page at the **exact viewport dimensions** recorded in `truth.json.viewport`
(hard requirement — `compare.js` refuses to score a viewport mismatch).

Scoring algorithm:

1. Verify `truth.viewport` matches `scene.viewport` exactly — abort with a
   clear error otherwise (comparing geometry across mismatched frames is
   meaningless).
2. Greedy one-to-one node matching: compute IoU for every truth×scene pair
   of the same `kind` (box↔box, text↔text), sort descending, assign
   greedily; only pairs above IoU > 0.3 count as a match.
3. Per matched pair: IoU, color ΔE (`fill`/`color` when both non-null), text
   exact-match (text nodes, after whitespace normalization).
4. Aggregate: precision (`matched / scene.length`), recall
   (`matched / truth.length`), mean IoU, mean color ΔE, % text matched.
   Printed directly in the `eval-log.md` entry format (see below) for
   copy-paste.

Two deliberate simplifications, marked in code as `// ponytail:` comments
per this project's convention:

- **Color distance is Euclidean RGB, not CIEDE2000.** Good enough to tell
  "close" from "wrong" for this first pass. The perceptually-accurate
  CIEDE2000 implementation already exists in
  `.claude/finan-qc/ui-engine/` (a *different* project's venv, not
  installed here) — upgrade path is to pull that in if Euclidean proves
  misleading.
- **Text matching is exact-string, not fuzzy.** Upgrade to Levenshtein/fuzzy
  matching if OCR-style near-misses (one or two character drift) turn out to
  dominate the error signal.

CLI: `node bench/compare.js bench/fixtures/<case> --scene scene.<provider>.<model>.json`
— one fixture per run; no batch/multi-fixture summary in this iteration (5
fixtures run by hand is fine at this scale).

## Reusable knowledge: `.claude/skills/vision-scene-prompt/`

Already written (this session). Captures the prompt-tuning rules above, a
provider-quirks table, and points to `references/eval-log.md` — append one
entry per tuning attempt (what changed, score delta, kept/reverted) so a
future session doesn't blind-repeat a rejected change. `references/current-prompt.md`
and `references/node-schema.json` are documentation mirrors of the actual
constants in `src/image-scene.js` — the code is the source of truth; these
exist to be reviewable without reading JS.

## Testing

Per this project's convention (`superpowers:test-driven-development` /
CLAUDE.md testing section), the two new pure-logic units need tests:

- `bench/compare.js`'s IoU/matching/scoring functions — unit-testable with
  hand-constructed node lists (no image, no network), following the existing
  pattern in `test/renderer.test.js` (mocked inputs, no real Figma/browser).
- `src/image-scene.js`'s non-network logic: viewport extraction from a PNG's
  IHDR chunk, the "reject images over 2576px" guard, and the
  post-processing that fills in the code-supplied fields (`version`,
  `opacity`, etc.) onto model output.

Network calls to Ollama/OpenAI are **not** unit tested — they're exercised
manually via the `npm run image` / `npm run bench` loop described in the
implementation plan, consistent with this being a research script rather
than product code with an SLA.

## File/script summary

```
src/
  image-scene.js              # new — CLI: image → scene.json
  providers/
    ollama.js                 # new
    openai.js                 # new
bench/
  compare.js                  # new
  fixtures/                   # new — shot.png + truth.json committed; scene.*.json gitignored
.claude/skills/vision-scene-prompt/   # already written this session
```

`package.json` gains two scripts: `"image": "node src/image-scene.js"`,
`"bench": "node bench/compare.js"`. No new dependencies.

## Environment prerequisites (not yet done)

- Ollama not installed on this machine (`which ollama` → not found). Needs
  `brew install ollama && ollama pull qwen2.5vl:7b` before the local-provider
  path can run.
- `OPENAI_API_KEY` not currently set in this environment.
- `ANTHROPIC_API_KEY` not set either, but irrelevant — Anthropic was
  explicitly dropped as a provider for this iteration in favor of
  OpenAI + Ollama.
