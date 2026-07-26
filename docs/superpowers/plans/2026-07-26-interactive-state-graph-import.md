# Interactive State Graph Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, bounded HTML interaction explorer that streams editable state pages into Figma and links them with prototype reactions while preserving the existing static import path.

**Architecture:** The browser keeps the current v1 scene capture and adds a v2 breadth-first state graph. Each action gets a stable `actionKey`; each captured scene node may carry that key. Direct Figma import uses a start/state/finish message stream, while ZIP and CLI-generated plugins render a completed graph sequentially. The Figma renderer returns page/root/action-node mappings, then applies reactions after destination pages exist.

**Tech Stack:** Vanilla browser APIs, Figma Plugin API with `setReactionsAsync`, Node `node:test`, existing dependency-free packaging and ZIP code.

## Global Constraints

- v1 remains the default and its scene schema/renderer output remains unchanged.
- Interactive mode is opt-in and bounded by `maxDepth: 2`, `maxStates: 8`, `maxActionsPerState: 8`, `stateTimeoutMs: 1500`, and `settleMs: 80`.
- Use fresh sandboxed iframes for state paths; skip hidden, disabled, decorative, and external-navigation candidates.
- Use stable action keys instead of candidate indexes in `actionPath` and `transitions`.
- Keep direct import, ZIP download, CLI-generated plugin, page-name input, and collision-safe page naming working.
- Use `figma.setCurrentPageAsync(page)` and `setReactionsAsync()`; never assign `figma.currentPage` or the read-only `reactions` property.
- Do not add dependencies, Playwright, or a second programming language/runtime.
- Do not discard the existing uncommitted draft changes; reconcile them with these contracts and commit only after tests and Figma verification pass.

---

## File Map

- `web/scene-capture.js`: v1 capture plus v2 action discovery, stable keys, state graph, fingerprints, and callbacks.
- `web/index.html`: interactive-mode progress, partial graph buffering, direct-import stream, ZIP serialization, and user status.
- `src/bridge-code.js`: direct Figma message protocol, streamed state rendering, page/action mappings, prototype reactions, and v1 fallback.
- `web/plugin-code.js`: same renderer/reaction behavior embedded in downloaded ZIP plugins.
- `src/template.js`: same completed-graph behavior for CLI-generated plugins.
- `test/scene-capture.test.js`: capture contract tests for keys, graph limits, dedupe, transitions, and recovery.
- `test/plugin-bundle.test.js`: bundled UI/protocol contract tests.
- `test/renderer.test.js`: renderer/reaction contract tests across all three plugin implementations.
- `test/zip.test.js`: ZIP graph metadata contract.
- `dist/html-figma-importer/*`: generated plugin artifacts; regenerate, do not hand-edit.
- `web/downloads/html-figma-importer.zip`: generated download; regenerate, do not hand-edit.

## Task 1: Complete the v2 state graph contract

**Files:**
- Modify: `web/scene-capture.js`
- Test: `test/scene-capture.test.js`

**Interfaces:**
- `captureStateGraph(html, options, onState) -> Promise<StateGraph>`.
- `onState(state, partialGraph) -> void | Promise<void>` is called once for each newly deduplicated state.
- State graph shape:

```js
{
  version: 2,
  viewport: { width, height },
  states: [{ id, label, actionPath, scene }],
  transitions: [{ from, to, actionKey, trigger: 'ON_CLICK' }]
}
```

- A v1 scene node that represents an action may include `actionKey`; all other v1 fields stay unchanged.

- [ ] **Step 1: Add failing source-contract tests.** Assert that the capture source contains `onState`, `actionKey`, `transitions`, `data-c2figma-action-key`, `maxActionsPerState`, and a distinct-state fingerprint map. Add an assertion that replay uses an action key rather than only an array index.

- [ ] **Step 2: Run the focused test and verify it fails.**

```bash
node --test test/scene-capture.test.js
```

Expected: FAIL because the current draft uses `maxActions`, numeric paths, and has no transitions/action-key metadata.

- [ ] **Step 3: Implement stable action discovery.** Replace numeric candidate identity with this deterministic contract:

```js
const actionKeyFor = (element, occurrence) => {
  const raw = element.getAttribute('data-c2figma-action')
    || element.id
    || element.getAttribute('aria-label')
    || element.getAttribute('data-action')
    || element.textContent
    || element.tagName;
  const slug = raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 48) || 'action';
  return `action-${slug}-${String(occurrence).padStart(2, '0')}`;
};
```

Assign the generated key to `data-c2figma-action-key` in the iframe only, keep one key per candidate list, and return `{ key, label, trigger: 'ON_CLICK' }`. Replaying a path must locate the candidate by `key`, so DOM ordering changes caused by a previous click do not silently target a different control.

- [ ] **Step 4: Add action metadata to scene serialization.** Read `data-c2figma-action-key` while serializing each element and include `actionKey` only when present. Do not add the marker to text nodes or to the public HTML.

- [ ] **Step 5: Add transitions and dedupe.** Keep a `fingerprintToState` map. When a task produces a new fingerprint, add a state and call `onState`. When it reaches an existing fingerprint, do not add a duplicate state but still add a unique transition. Use `{kind, rounded bounds, text, fill, stroke, opacity, visibility}` for the fingerprint, preserving the current node cap.

- [ ] **Step 6: Enforce the exact limits and recovery behavior.** Use `maxActionsPerState` in every candidate slice, `maxDepth`, `maxStates`, `stateTimeoutMs`, and `settleMs`. A baseline failure rejects; a secondary path failure records no state and continues. Return `states` plus `transitions`, even when no interaction changes the visual output.

- [ ] **Step 7: Run the focused test and commit the capture contract.**

```bash
node --test test/scene-capture.test.js
git add web/scene-capture.js test/scene-capture.test.js
git commit -m "feat: model bounded interactive state graph"
```

Expected: all scene-capture tests pass.

## Task 2: Stream capture results through the web UI and direct-import protocol

**Files:**
- Modify: `web/index.html`
- Test: `test/plugin-bundle.test.js`, `test/zip.test.js`

**Interfaces:**
- Direct protocol messages from the UI:

```js
{ type: 'import-start', spec, pageName, totalHint: 0 }
{ type: 'import-state', state }
{ type: 'import-finish', graph }
{ type: 'import-error', message }
```

- `import-start` is sent when the user presses the Figma import button in interactive mode. Already buffered states are sent immediately; later `onState` callbacks send new states. `import-finish` is sent when capture completes.
- v1 continues sending one `{ type: 'import', scene, spec, pageName }` message.

- [ ] **Step 1: Add failing UI/protocol assertions.** Assert the bundled UI contains `import-start`, `import-state`, `import-finish`, `onState`, state-progress status, and `states.json`.

- [ ] **Step 2: Run the focused tests and verify the new assertions fail.**

```bash
node --test test/plugin-bundle.test.js test/zip.test.js
```

- [ ] **Step 3: Buffer partial graph state in `selected`.** Store `selected.graph = { version: 2, viewport, states: [], transitions: [] }` before exploration. Pass an `onState` callback to `captureStateGraph`; update `selected.graph`, state/layer counters, and `#status` after every callback. If direct import has started, post that state to Figma immediately.

- [ ] **Step 4: Implement interactive direct import.** On button click, send `import-start` once, send every buffered state in order, and mark the session active. When capture resolves, send `import-finish` with the complete graph. Keep the existing one-message v1 path unchanged.

- [ ] **Step 5: Keep ZIP generation deterministic.** For interactive mode, embed `states.json`, include the complete graph in generated `code.js`, and keep `scene.json` as the baseline scene when available. For static mode, omit graph behavior and preserve the current files.

- [ ] **Step 6: Update UI status handling.** Display capture progress separately from Figma render progress, e.g. `Đang khám phá 3/8 state` and `Đang tạo page state 2/4`. If a secondary state fails, retain existing states and show a short recoverable message.

- [ ] **Step 7: Run tests and commit the protocol/UI changes.**

```bash
node --test test/plugin-bundle.test.js test/zip.test.js
git add web/index.html test/plugin-bundle.test.js test/zip.test.js
git commit -m "feat: stream interactive states from importer UI"
```

## Task 3: Render streamed states and wire Figma prototype reactions

**Files:**
- Modify: `src/bridge-code.js`
- Test: `test/renderer.test.js`, `test/plugin-bundle.test.js`

**Interfaces:**
- `renderScene(scene, title, pageName) -> Promise<{ page, root, actionNodes, pageName }>`.
- `renderState(state, title, pageName) -> Promise<{ stateId, page, root, actionNodes }>`.
- `applyTransitions(graph, renderedStates) -> Promise<{ applied, skipped }>`.
- Renderer session messages are processed in arrival order; a state is rendered once.

- [ ] **Step 1: Add failing renderer contract tests.** Assert the bridge contains `import-start`, `import-state`, `import-finish`, `setReactionsAsync`, `actionNodes`, `destinationId`, `ON_CLICK`, and a transition skip notification. Assert v1 still contains the existing single `import` handler.

- [ ] **Step 2: Run the focused tests and verify they fail.**

```bash
node --test test/renderer.test.js test/plugin-bundle.test.js
```

- [ ] **Step 3: Refactor the current scene loop minimally.** Make `renderScene` return its page, root, and `Map` of `actionKey → Figma node`. Populate the map while creating scene nodes; preserve current parent-relative coordinates, per-side borders, overflow, SVG, text, positioned-layer ordering, progress messages, and page-name collision behavior.

- [ ] **Step 4: Add streamed session handling.** Keep one session object with `basePageName`, `title`, `states`, `rendered`, and a promise queue. Handle messages as follows:

```js
if (message.type === 'import-start') startSession(message);
if (message.type === 'import-state') enqueue(() => renderOneState(message.state));
if (message.type === 'import-finish') enqueue(async () => {
  await applyTransitions(message.graph, session.rendered);
  finishSession();
});
```

The queue must prevent overlapping Figma node creation when several browser callbacks arrive in one event loop turn. `finishSession` closes the plugin only after reactions are attempted. A state-render error reports the state label and keeps the session alive; a baseline/v1 error remains fatal.

- [ ] **Step 5: Add completed-graph compatibility.** Keep `renderGraph(graph, title, pageName)` for ZIP/CLI-style one-message imports. It calls `renderOneState` in graph order, emits `state-progress`, then calls `applyTransitions`.

- [ ] **Step 6: Apply reactions after all destination roots exist.** For each transition, resolve the source state/action node and destination root. Call:

```js
await sourceNode.setReactionsAsync([{
  trigger: { type: transition.trigger || 'ON_CLICK' },
  actions: [{
    type: 'NODE',
    destinationId: destination.root.id,
    navigation: 'NAVIGATE',
    transition: {
      type: 'DISSOLVE',
      duration: 0.2,
      easing: { type: 'EASE_IN_AND_OUT' }
    }
  }]
}]);
```

Count and report unmapped source actions, missing destinations, invalid triggers, and reaction API errors as skipped transitions. Never delete a page because a reaction fails.

- [ ] **Step 7: Run tests and commit the direct renderer.**

```bash
node --test test/renderer.test.js test/plugin-bundle.test.js
git add src/bridge-code.js test/renderer.test.js test/plugin-bundle.test.js
git commit -m "feat: stream state pages and prototype links"
```

## Task 4: Mirror the completed-graph renderer in generated plugins

**Files:**
- Modify: `web/plugin-code.js`
- Modify: `src/template.js`
- Test: `test/renderer.test.js`

**Interfaces:**
- Both generated-plugin paths expose the same completed-graph behavior as `src/bridge-code.js`: `renderScene`, `renderGraph`, action-node maps, `applyTransitions`, and page naming.
- Generated plugins do not need browser-side streamed messages; they receive the completed graph embedded in `code.js`.

- [ ] **Step 1: Add failing parity assertions.** For `web/plugin-code.js` and `src/template.js`, assert `setReactionsAsync`, `actionKey`, `destinationId`, `DISSOLVE`, and `state-progress` are present in the generated renderer source/template.

- [ ] **Step 2: Run the focused test and verify it fails.**

```bash
node --test test/renderer.test.js
```

- [ ] **Step 3: Port the minimal renderer changes.** Keep each file's existing generation style; do not introduce a shared runtime dependency. Each completed-graph renderer creates all pages, maps actions, applies transitions, and closes the plugin after reaction processing. Static scene behavior remains unchanged.

- [ ] **Step 4: Run the parity test and commit.**

```bash
node --test test/renderer.test.js
git add web/plugin-code.js src/template.js test/renderer.test.js
git commit -m "feat: add prototype links to generated plugins"
```

## Task 5: Package, regression-test, and verify in Figma

**Files:**
- Regenerate: `dist/html-figma-importer/code.js`
- Regenerate: `dist/html-figma-importer/ui.html`
- Regenerate: `dist/html-figma-importer/manifest.json`
- Regenerate: `web/downloads/html-figma-importer.zip`
- Verify: `/Users/finanone/Downloads/[Nhân viên] - Quản lý nhân viên - Standalone.html`

- [ ] **Step 1: Run the complete automated gate.**

```bash
npm test
npm run plugin:package
git diff --check
```

Expected: all tests pass; package generation succeeds; no whitespace errors.

- [ ] **Step 2: Check generated artifacts.** Confirm generated UI has no external `/scene-capture.js` or `/plugin-code.js` references, generated code uses `figma.setCurrentPageAsync` and `setReactionsAsync`, and manifest keeps `documentAccess: "dynamic-page"`.

- [ ] **Step 3: Sync the generated ZIP and manifest to the existing Downloads test locations.** Use the package script output and copy only the generated plugin artifacts; do not overwrite unrelated files.

- [ ] **Step 4: Run the direct Figma smoke test with the employee sample.**

Verify:

1. Static mode creates one editable page with the same layer quality as the current baseline.
2. Interactive mode shows at least `Default` plus one changed state page.
3. Pages use the user-selected base name and collision suffixes.
4. The row/CTA source node has a prototype reaction to the destination state.
5. A reaction mapping failure leaves the visual pages intact.
6. Layer counts and right-edge/table/text clipping do not regress.

- [ ] **Step 5: Run the generated ZIP smoke test.** Import its `manifest.json` in Figma Desktop and verify the same two state pages and one prototype link.

- [ ] **Step 6: Commit generated artifacts only after verification.**

```bash
git add dist/html-figma-importer web/downloads/html-figma-importer.zip
git commit -m "build: package interactive state graph importer"
```

- [ ] **Step 7: Push after the user-visible verification is green.**

```bash
GIT_CONFIG_GLOBAL=/dev/null git push origin main
```

## Self-review checklist

- [x] v1 default, fallback, and no-new-dependency constraints are covered.
- [x] State discovery limits, fresh iframe isolation, stable keys, dedupe, and per-state recovery are assigned to Task 1.
- [x] UI capture progress, direct streaming, ZIP metadata, and user status are assigned to Task 2.
- [x] Editable state pages, action-node mappings, async reactions, and reaction failure isolation are assigned to Task 3.
- [x] ZIP/CLI renderer parity is assigned to Task 4.
- [x] Build, artifact inspection, direct Figma verification, and push gate are assigned to Task 5.
- [x] No task relies on a placeholder or an undefined function; interfaces are defined before use.
- [x] The direct stream uses `import-start` / `import-state` / `import-finish`; v1 still uses the existing `import` message.
- [x] Pure CSS hover remains explicitly best-effort and does not expand this increment into a browser-automation dependency.
