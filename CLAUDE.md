# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                    # node --test — runs everything in test/
node --test test/scene-capture.test.js      # single test file
node --test --test-name-pattern="<name>"    # single test by name

npm run plugin                              # build Figma plugin -> dist/html-figma-importer/
npm run plugin:package                      # build + zip -> web/downloads/html-figma-importer.zip (run before pushing web changes)
npm run import -- "/path/to/design.html" --out dist/design   # CLI metadata fallback (no visual capture)

# image -> scene research pipeline
npm run image -- shot.png --out scene.json [--provider ollama|openai] [--model NAME] [--api-key KEY]
npm run bench -- bench/fixtures/<case> --scene scene.ollama.json   # score a generated scene vs truth.json

# optional fallback-rules backend (Python, separate toolchain)
cd backend && pip install -r requirements-dev.txt && python -m pytest
cd backend && REDIS_URL=redis://localhost:6379 uvicorn main:app --reload
```

No build step, no bundler, no npm dependencies (`package.json` has none). Plain CommonJS (`node:*` requires) on the Node side, plain browser globals on the web side. Only `backend/` has third-party deps (FastAPI + redis), and it is optional.

## Architecture

Three ways to produce a scene; all of them converge on the same wire format — `{version:1, viewport, nodes}` (flat node list) or `{version:2, states, transitions}` — and the same two copies of the renderer.

**1. No-command flow (primary, in `web/`)**
- `web/index.html` — drag-and-drop UI. User drops standalone HTML, picks a capture mode, downloads a ZIP (or, in "Direct Import" mode, sends the scene straight to a running Figma plugin instance).
- `web/scene-capture.js` — the core capture engine, runs in the browser:
  - Loads the dropped HTML into a hidden sandboxed `<iframe>` and waits for it to visually settle (`captureSceneGraph`, `settleProfileFor`) before reading it. Bundled/Claude-generated HTML (detected via `__bundler/...` markers) gets a longer settle budget and a relaxed `allow-same-origin` sandbox because it hydrates from blob URLs.
  - `serializeScene` walks the live DOM inside the iframe and turns every visible element into a flat node list (box/text/svg, position, fill, stroke, radius, z-index) — this flat list *is* the wire format consumed by the renderer (`{version:1, viewport, nodes}}`).
  - `captureStateGraph` explores interactive HTML: discovers clickable elements, replays click paths breadth-first up to `maxDepth`/`maxActionsPerState` (see `LIMITS`), dedupes states by a fingerprint (`sceneFingerprint`, deliberately ignoring opacity/fractional bounds so a mid-fade frame doesn't count as a new state), and records transitions between states. Two capture modes: `fresh` (one iframe per interaction, most accurate) and `reuse` (one iframe replayed repeatedly, resetting to baseline via Escape/backdrop-click/reload — faster but the reused iframe can fail to restore and forces a reload+retry, see `reusableProbe`). Output is `{version:2, states, transitions}`.
- `web/plugin-code.js` — generates the actual Figma plugin `code.js` source as a template string, embedding either a static scene (`INITIAL_SCENE`) or a full state graph (`STATE_GRAPH`, appended by `index.html` only for interactive exports). Contains `renderScene`/`renderGraph`/`applyTransitions`, which turn the wire-format nodes back into real Figma nodes and wire up prototype reactions between states.

**2. Direct Import plugin (in `src/`, built by `npm run plugin`)**
- `src/plugin-bundle.js` builds a manifest + `code.js` (from `src/bridge-code.js`) + `ui.html` (that's `web/index.html` with `scene-capture.js`/`plugin-code.js` inlined via string replace, so the same drop-zone UI runs *inside* Figma's plugin panel).
- `src/bridge-code.js` is the plugin-side counterpart to `web/plugin-code.js` — same renderer logic (`renderScene`, `renderGraph`, `applyTransitions`), but driven by a message protocol (`import-start`/`import-state`/`import-finish`) so a state graph can stream in incrementally as the UI explores it live, instead of arriving as one finished payload. Keep both renderer copies in sync when touching layout/fill/stroke/z-order logic — same intent, two entry points.
- `src/plugin-package.js` also zips this bundle to `web/downloads/html-figma-importer.zip` via `src/zip.js` (hand-rolled STORE-only ZIP writer, no compression, no dependency).
- `src/cli.js`/`src/extract-html.js`/`src/template.js` — a much cruder CLI fallback that regex-scrapes static HTML (title, CSS custom properties, headings, labels) without ever rendering it. Explicitly secondary; doesn't produce a real scene graph.

**3. Image → scene pipeline (research path, `npm run image`)**

Same destination as flow 1 (a `version:1` scene the renderer eats), but the input is a PNG screenshot and the "capture engine" is a vision model instead of the DOM. Useful when there is no HTML to drop.
- `src/image-scene.js` — CLI + post-processing boundary. Reads the PNG, hard-fails via `src/png-size.js` if the long edge exceeds `MAX_LONG_EDGE` (2576px — the vision API would silently downscale and desync every returned coordinate), calls a provider, then `fillNodeDefaults`/`hexToWire` translate the model's hex colors to the renderer's `{r,g,b,a}` 0..1 and fill in the wire-format fields a model cannot infer (`opacity`, `position`, `zIndex`, `overflow`, `lines`, `svg`, `borders`). The model never learns the wire format; this one function is the whole adapter.
- `src/scene-prompt.js` (`buildPrompt`) + `src/scene-schema.js` (`NODE_SCHEMA`) — shared by both providers. The JSON Schema carries the *format* contract (Ollama `format`, OpenAI `response_format.json_schema` with `strict:true`); the prompt carries only the semantics a schema can't express (what `parentId` means, parents-before-children ordering, how to pick a dominant color).
- `src/providers/ollama.js` (local `qwen2.5vl:7b`, default) and `src/providers/openai.js` (`gpt-4o-mini`). Both take an injectable `fetch` so tests never hit the network. Ollama streams NDJSON deliberately — a `stream:false` call withholds the whole response and Node's ~5-minute headers timeout kills the connection on a dense screen before the first byte; a `done_reason: "length"` cut-off is surfaced as a "raise numCtx/numPredict" hint rather than a bare JSON parse error.
- `bench/compare.js` (`npm run bench`) — scores a generated scene against DOM-derived ground truth: greedy IoU node matching (`MATCH_THRESHOLD` 0.3), mean IoU, RGB color delta, exact text-match rate, precision/recall. `truth.json` is produced by flow 1 (export the same page via `web/index.html`), so the HTML pipeline is the oracle for the vision pipeline. Fixture layout and the exact capture steps are in `bench/fixtures/README.md`; `shot.png`/`truth.json` are committed, generated `scene.*.json` are gitignored.
- Before touching the prompt or `NODE_SCHEMA`, use the `vision-scene-prompt` skill (`.claude/skills/vision-scene-prompt/`): it holds the provider quirks table, the rules behind the prompt's current shape, and `references/eval-log.md` — the record of tunings already tried and rejected. Change one thing per bench run or the score delta is unattributable.

### Optional fallback-rules backend (`backend/`)
`src/bridge-code.js` (Direct Import only — not `web/plugin-code.js`, not the CLI) can report which SVG/fill signatures are known to fail rendering and recall them on the next import, skipping straight to the safe handling. Backed by `backend/main.py` (FastAPI `GET`/`POST /rules`) over `backend/store.py` (Redis, 90-day TTL, `FALLBACK_KINDS` whitelist).

Disabled by default and gated behind two deliberate placeholders — `RULES_API_BASE` = `REPLACE_WITH_DEPLOYED_RULES_API_URL` in `src/bridge-code.js`, and `networkAccess.allowedDomains: ['none']` in `src/plugin-bundle.js`. With those unedited the plugin makes no network call at all, so a rebuild can't leak; enabling it means editing both plus a rebuild (see README). `svg|plain` is carved out of auto-recall on purpose — it is the signature of an SVG with no exotic features, too generic to blacklist.

### Renderer invariants worth knowing before touching layout code
- Figma has no z-index: `stackLevel`/`compareStack`/`zPath` hoist absolutely/fixed-positioned, z-indexed elements to the root frame and sort them by their full stacking-ancestor path so overlays/dropdowns/dialogs paint above their siblings correctly.
- Multi-state graphs share one Figma page per import; `placeState`/`STATE_GAP`/`ROW_GAP`/`COLUMNS` lay states out in wrapping rows grouped by exploration depth (`DEPTH_LABELS`), so a page reads as sections instead of one endless row.
- A per-node render failure (e.g. an SVG Figma rejects) is caught and reported (`issues`/`render-issues` postMessage + `figma.notify`) without aborting the whole state — one bad layer must not cost the whole import.

### Testing
`test/renderer.test.js` and `test/scene-capture.test.js` are the heaviest suites — they exercise the wire-format renderer and the DOM-capture engine respectively via lightweight mocked `figma`/`document` globals rather than a real Figma or browser environment. When changing the shared node-shape (fills, borders, z-order, state graph fields), expect to update both the capture side and both renderer copies (`src/bridge-code.js` and `web/plugin-code.js`), plus their tests.

Provider tests inject a fake `fetch` (`test/providers-*.test.js`) — no network, no API key, no running Ollama. `test/web-routing.test.js` asserts every absolute `src`/`href` in `web/index.html` is either rewritten by `vercel.json` or a real file at the repo root; the deploy has no build step, so this is the only thing standing between an edit and a 404 in production. `backend/` is pytest + `fakeredis` and is *not* run by `npm test` — run it separately when touching Python.

## Conventions

- Vietnamese strings are used for all end-user-facing notifications/labels/errors (`figma.notify`, UI copy) — keep new user-facing strings in Vietnamese to match. Deliberate exception: the vision prompt in `src/scene-prompt.js` is English even though the screenshots are Vietnamese UIs, because instruction-following on the weak local model is measurably better in English. That rule is about copy a human reads, not a prompt sent to an API.
- `// ponytail: ...` comments mark a deliberate simplification and its upgrade path (e.g. "sample one repeated sibling, add full coverage via `data-c2figma-force-explore` if ever needed") — read them before "fixing" what looks like a shortcut.
- Build output is committed on purpose: `dist/html-figma-importer/` (so the manifest can be imported straight from a clone) and `web/downloads/html-figma-importer.zip` (whitelisted past the `*.zip` gitignore, served by the web app). Rebuild both before pushing web changes.
- Each feature has a design spec + implementation plan under `docs/superpowers/specs/` and `docs/superpowers/plans/` — read the matching doc before extending a feature; it usually explains why an option was rejected.
