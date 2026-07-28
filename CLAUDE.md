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
```

No build step, no bundler, no dependencies (`package.json` has none). Plain CommonJS (`node:*` requires) on the Node side, plain browser globals on the web side.

## Architecture

Two independent ways to get an HTML file's design into Figma; both converge on the same plugin renderer code.

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

### Renderer invariants worth knowing before touching layout code
- Figma has no z-index: `stackLevel`/`compareStack`/`zPath` hoist absolutely/fixed-positioned, z-indexed elements to the root frame and sort them by their full stacking-ancestor path so overlays/dropdowns/dialogs paint above their siblings correctly.
- Multi-state graphs share one Figma page per import; `placeState`/`STATE_GAP`/`ROW_GAP`/`COLUMNS` lay states out in wrapping rows grouped by exploration depth (`DEPTH_LABELS`), so a page reads as sections instead of one endless row.
- A per-node render failure (e.g. an SVG Figma rejects) is caught and reported (`issues`/`render-issues` postMessage + `figma.notify`) without aborting the whole state — one bad layer must not cost the whole import.

### Testing
`test/renderer.test.js` and `test/scene-capture.test.js` are the heaviest suites — they exercise the wire-format renderer and the DOM-capture engine respectively via lightweight mocked `figma`/`document` globals rather than a real Figma or browser environment. When changing the shared node-shape (fills, borders, z-order, state graph fields), expect to update both the capture side and both renderer copies (`src/bridge-code.js` and `web/plugin-code.js`), plus their tests.

## Conventions

- Vietnamese strings are used for all end-user-facing notifications/labels/errors (`figma.notify`, UI copy) — keep new user-facing strings in Vietnamese to match.
- `// ponytail: ...` comments mark a deliberate simplification and its upgrade path (e.g. "sample one repeated sibling, add full coverage via `data-c2figma-force-explore` if ever needed") — read them before "fixing" what looks like a shortcut.
