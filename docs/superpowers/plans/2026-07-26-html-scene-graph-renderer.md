# HTML Scene Graph Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fixed Figma scaffold with a generic renderer that captures the uploaded HTML's real browser layout and recreates its common visual primitives as editable Figma layers.

**Architecture:** The web UI renders the uploaded HTML in a sandboxed iframe and serializes its visible DOM, computed styles, text runs, and absolute bounds into a scene graph. The Figma plugin receives that graph and creates frames/text nodes using parent-relative coordinates. The same renderer code is available to the direct plugin and the downloadable ZIP; the web bundle inlines its browser assets when packaged.

**Tech Stack:** Vanilla browser APIs, Figma Plugin API, Node `node:test`, existing dependency-free ZIP/package scripts.

## Global Constraints

- Keep the project dependency-free.
- Preserve `documentAccess: "dynamic-page"` and use `figma.setCurrentPageAsync`.
- Keep the web fallback and direct Figma import flows working.
- Do not hardcode the Nhân viên screen into the renderer.
- Cap captured nodes and wait time so arbitrary HTML cannot hang the importer.
- Figma output is editable approximation of common HTML/CSS primitives; unsupported assets degrade to styled boxes.

### Task 1: Split browser capture and generated plugin code

**Files:**
- Create: `web/scene-capture.js`
- Create: `web/plugin-code.js`
- Modify: `web/index.html`
- Modify: `src/plugin-bundle.js`
- Test: `test/plugin-bundle.test.js`

**Interfaces:**
- `captureSceneGraph(html, options) -> Promise<SceneGraph>` in `web/scene-capture.js`.
- `pluginCode(scene) -> string` in `web/plugin-code.js`.
- `createPluginBundle().ui` must inline local `/scene-capture.js` and `/plugin-code.js` so `ui.html` remains standalone.

- [ ] Write a failing bundle contract asserting the packaged UI contains `captureSceneGraph`, `pluginCode`, and no external `/scene-capture.js` or `/plugin-code.js` references.
- [ ] Run `npm test -- test/plugin-bundle.test.js` and confirm the new contract fails because the assets do not exist.
- [ ] Add the two browser assets and update `plugin-bundle.js` to replace local script tags with their file contents when building a plugin UI.
- [ ] Move the current generated ZIP code template out of `web/index.html` into `web/plugin-code.js` and keep its public `pluginCode(scene)` function.
- [ ] Run the targeted bundle test and confirm it passes.

### Task 2: Capture the rendered HTML into a scene graph

**Files:**
- Modify: `web/scene-capture.js`
- Modify: `web/index.html`
- Test: `test/plugin-bundle.test.js`

**Interfaces:**
- Scene graph shape:

```js
{
  version: 1,
  viewport: { width: number, height: number },
  nodes: [{
    id: string,
    parentId: string | null,
    kind: 'box' | 'text',
    name: string,
    x: number, y: number, width: number, height: number,
    fill: { r: number, g: number, b: number, a: number } | null,
    stroke: { r: number, g: number, b: number, a: number } | null,
    strokeWidth: number,
    radius: number,
    opacity: number,
    text: string,
    fontSize: number,
    fontWeight: number,
    color: { r: number, g: number, b: number, a: number } | null
  }]
}
```

- [ ] Add a contract assertion that the UI invokes `captureSceneGraph` before sending `pluginMessage` and includes `scene` in the message.
- [ ] Implement a sandboxed iframe capture with a fixed 1440×900 viewport, postMessage serialization, a bounded 2-second wait, and a clear error on timeout.
- [ ] Walk visible elements, preserve parent IDs, capture computed background/border/radius/opacity/font styles, and create text nodes from direct text ranges to avoid duplicate nested text.
- [ ] Skip scripts, styles, metadata, zero-size/hidden nodes, and cap the graph at 2,000 nodes.
- [ ] Keep the existing title/token/headings/labels summary extraction for the web UI.
- [ ] Run the targeted test and verify the source contains the scene graph contract.

### Task 3: Render scene graph nodes into editable Figma layers

**Files:**
- Modify: `src/bridge-code.js`
- Modify: `web/plugin-code.js`
- Modify: `src/template.js`
- Test: `test/plugin-bundle.test.js`

**Interfaces:**
- Plugin message: `{ type: 'import', scene }`.
- Renderer: `async render(scene)` creates one page and one root frame, then appends each node under its `parentId` using parent-relative coordinates.

- [ ] Add failing assertions that the plugin code consumes `message.scene`, calls `figma.setCurrentPageAsync`, and no longer contains the fixed `Sidebar`, `Generated visual scaffold`, or `Primary action` scaffold strings.
- [ ] Run the targeted test and confirm it fails against the current scaffold.
- [ ] Implement box rendering with fills, strokes, opacity, corner radius, and named layers.
- [ ] Implement text rendering with Inter font fallback, weight mapping, font size, color, and parent-relative bounds.
- [ ] Add a safe fallback for empty/invalid scenes and keep plugin notifications/UI error messages.
- [ ] Mirror the renderer contract in `web/plugin-code.js` for generated ZIPs.
- [ ] Update `src/template.js` so CLI-generated plugins use the same scene protocol instead of the fixed scaffold.
- [ ] Run the targeted test and verify it passes.

### Task 4: Wire import and ZIP flows to capture scenes

**Files:**
- Modify: `web/index.html`
- Modify: `web/plugin-code.js`
- Modify: `src/plugin-package.js`
- Test: `test/plugin-bundle.test.js`, `test/zip.test.js`

- [ ] Make file selection/drag-drop asynchronous: parse the summary, capture the scene, store `{ file, html, spec, scene }`, and report capture progress/errors in `#status`.
- [ ] Send `scene` for direct Figma import and show the node count in the summary.
- [ ] Include `scene.json` in generated ZIPs and embed the same scene in generated `code.js`.
- [ ] Keep manifest fields and README instructions unchanged except for the scene-based flow description.
- [ ] Run all tests and package the plugin/ZIP.

### Task 5: Verify generated artifacts and sample fidelity

**Files:**
- Regenerate: `dist/html-figma-importer/code.js`
- Regenerate: `dist/html-figma-importer/ui.html`
- Regenerate: `web/downloads/html-figma-importer.zip`
- Verify: `/Users/finanone/Downloads/[Nhân viên] - Quản lý nhân viên - Standalone.html`

- [ ] Run `npm test`, `npm run plugin:package`, and `git diff --check`.
- [ ] Confirm packaged UI has no external script references and packaged code contains the async dynamic-page API.
- [ ] Use Codex Browser on the sample HTML to capture the source default and one drawer/empty state for parity evidence.
- [ ] Use the warehouse sample set as cross-layout fixtures: `Tồn kho` (KPI + table), `Sổ kho` (tabs + ledger), `Kiểm kê` (tabs + table), `Sổ nhập kho` (form-heavy table), and `Sổ xuất kho` (status ledger).
- [ ] Keep the audit tab for the next parity iteration and record unsupported features rather than silently claiming pixel parity.
- [ ] Commit the focused implementation after verification.
