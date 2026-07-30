# Image → Figma Research Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone CLI (`src/image-scene.js`) that turns a screenshot into a wire-format-v1 `scene.json` via a vision model (Ollama local or OpenAI hosted), plus a scoring tool (`bench/compare.js`) that measures how close that output gets to the existing DOM-derived ground truth.

**Architecture:** Two provider adapters (`src/providers/ollama.js`, `src/providers/openai.js`) share one prompt/schema module and expose the same `generate(imageBase64, opts) -> Promise<Array<Node>>` signature. `src/image-scene.js` is a thin CLI that reads a PNG, calls the selected provider, fills in the wire-format fields a vision model can't infer, and writes `scene.json`. `bench/compare.js` is an independent scorer: IoU-based greedy node matching, Euclidean-RGB color delta, exact-string text match, against a manually-captured `truth.json`.

**Tech Stack:** Plain Node.js (CommonJS, `require`/`module.exports`), `node:test` + `node:assert/strict` for tests, global `fetch` (Node 24) for both providers — no new npm dependency.

## Global Constraints

- **Zero new npm dependencies.** `package.json` has none today and stays that way — both providers use Node's built-in global `fetch`, not the `openai` SDK package.
- **CommonJS**, matching every existing file under `src/` — `require(...)` / `module.exports = {...}`, no ESM.
- **Tests via `node:test` + `node:assert/strict`**, discovered by the existing `npm test` (`node --test`) script. Follow the existing dependency-injection pattern for network calls: accept `fetch` as an overridable option (see `test/bridge-code-fallback-rules.test.js`'s `makeFetchMock` for the exact mock shape: `{ ok, json: () => Promise.resolve(...) }`).
- **Do not modify** `web/`, `src/bridge-code.js`, `src/plugin-bundle.js`, the plugin manifest, or `backend/`. This pipeline is additive-only.
- **Prompt strings are English**, not Vietnamese — this is a system prompt sent to an API, not user-facing UI copy, so the project's "Vietnamese for user-facing strings" convention does not apply here. See `.claude/skills/vision-scene-prompt/SKILL.md` for the reasoning.
- **Images over 2576px on the long edge are rejected with a clear error**, never silently resized — a resize would desync the model's returned coordinates from the real image.
- **`.claude/skills/vision-scene-prompt/references/current-prompt.md` and `references/node-schema.json`** are documentation mirrors of `src/scene-prompt.js` / `src/scene-schema.js`. If either source file changes during this implementation, update the mirrored reference file in the same task's commit.

---

### Task 1: Shared prompt + JSON Schema module

**Files:**
- Create: `src/scene-schema.js`
- Create: `src/scene-prompt.js`
- Test: `test/scene-prompt-schema.test.js`

**Interfaces:**
- Consumes: nothing (no dependencies on other tasks).
- Produces: `NODE_SCHEMA` (JSON Schema object, from `src/scene-schema.js`) and `buildPrompt(width, height) -> string` (from `src/scene-prompt.js`). Tasks 3, 4, and 5 both `require` these.

- [ ] **Step 1: Write the failing test**

```js
// test/scene-prompt-schema.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { NODE_SCHEMA } = require('../src/scene-schema');
const { buildPrompt } = require('../src/scene-prompt');

test('NODE_SCHEMA requires a top-level nodes array', () => {
  assert.equal(NODE_SCHEMA.type, 'object');
  assert.deepEqual(NODE_SCHEMA.required, ['nodes']);
  assert.equal(NODE_SCHEMA.additionalProperties, false);
  assert.equal(NODE_SCHEMA.properties.nodes.type, 'array');
});

test('NODE_SCHEMA node items require exactly the wire-format-derivable fields', () => {
  const item = NODE_SCHEMA.properties.nodes.items;
  const expectedFields = [
    'id', 'parentId', 'kind', 'name', 'x', 'y', 'width', 'height',
    'fill', 'stroke', 'strokeWidth', 'radius', 'text', 'fontSize',
    'fontWeight', 'color'
  ];
  assert.deepEqual(Object.keys(item.properties).sort(), [...expectedFields].sort());
  assert.deepEqual(item.required.sort(), [...expectedFields].sort());
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.properties.kind.enum, ['box', 'text']);
});

test('buildPrompt interpolates the given viewport size', () => {
  const prompt = buildPrompt(390, 844);
  assert.match(prompt, /390x844px/);
  assert.doesNotMatch(prompt, /\$\{width\}|\$\{height\}/, 'no leftover template placeholders');
});

test('buildPrompt uses MUST/NEVER signal words and the grounding-against-fabrication rule', () => {
  const prompt = buildPrompt(100, 100);
  assert.match(prompt, /\bMUST\b/);
  assert.match(prompt, /\bNEVER\b/);
  assert.match(prompt, /invent a node that is not visible/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scene-prompt-schema.test.js`
Expected: FAIL — `Cannot find module '../src/scene-schema'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/scene-schema.js
const NODE_SCHEMA = {
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          parentId: { type: ['string', 'null'] },
          kind: { type: 'string', enum: ['box', 'text'] },
          name: {
            type: 'string',
            description: 'Semantic label: "Button / Submit", "Card / Product", "Text / Hello" — not "div1"'
          },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          fill: {
            type: ['string', 'null'],
            description: 'Hex color, e.g. #FF5733, or null if transparent'
          },
          stroke: { type: ['string', 'null'] },
          strokeWidth: { type: 'number' },
          radius: { type: 'number' },
          text: { type: 'string' },
          fontSize: { type: 'number' },
          fontWeight: { type: 'number', enum: [400, 500, 600, 700] },
          color: { type: ['string', 'null'] }
        },
        required: [
          'id', 'parentId', 'kind', 'name', 'x', 'y', 'width', 'height',
          'fill', 'stroke', 'strokeWidth', 'radius', 'text', 'fontSize',
          'fontWeight', 'color'
        ],
        additionalProperties: false
      }
    }
  },
  required: ['nodes'],
  additionalProperties: false
};

module.exports = { NODE_SCHEMA };
```

```js
// src/scene-prompt.js
function buildPrompt(width, height) {
  return `You are a UI screenshot analyst extracting layout data for a Figma import pipeline. Precision matters more than completeness — a wrong coordinate breaks the import.

Image size: ${width}x${height}px. Origin (0,0) is top-left.

TASK: List every visible box (rectangle/card/button/container) and every distinct text block as flat nodes.

MUST:
- x,y = top-left corner, measured in absolute pixels against the ${width}x${height} frame you were told — not eyeballed proportionally
- parentId = the id of the immediate visual container only, never a distant ancestor. Top-level nodes: parentId = null
- fill/stroke/color = hex string of the dominant color in that region
- name = semantic role, e.g. "Button / Submit", "Card / Product 1", "Text / Title" — never "Rectangle 1" or "div"

NEVER:
- invent a node that is not visible in the image
- guess a color when the region is transparent or unclear — use null instead
- skip a node because you are unsure of its exact bounds — estimate it

If a value is genuinely unknown, use null. Do not leave required fields empty strings as a substitute.`;
}

module.exports = { buildPrompt };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scene-prompt-schema.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/scene-schema.js src/scene-prompt.js test/scene-prompt-schema.test.js
git commit -m "feat: add shared vision-scene JSON schema and prompt builder"
```

---

### Task 2: PNG viewport reader + oversized-image guard

**Files:**
- Create: `src/png-size.js`
- Test: `test/png-size.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `readPngSize(buffer) -> {width: number, height: number}` and `assertImageSize({width, height}) -> void` (throws `Error` if the long edge exceeds `MAX_LONG_EDGE`). Also exports `MAX_LONG_EDGE` (2576). Task 5 (`src/image-scene.js`) requires both functions.

- [ ] **Step 1: Write the failing test**

```js
// test/png-size.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { readPngSize, assertImageSize, MAX_LONG_EDGE } = require('../src/png-size');

function fakePng(width, height) {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test('readPngSize reads width/height from the IHDR chunk', () => {
  const size = readPngSize(fakePng(390, 844));
  assert.deepEqual(size, { width: 390, height: 844 });
});

test('readPngSize rejects a buffer with the wrong signature', () => {
  const notPng = Buffer.alloc(24, 0);
  assert.throws(() => readPngSize(notPng), /Not a valid PNG/);
});

test('readPngSize rejects a too-short buffer', () => {
  assert.throws(() => readPngSize(Buffer.alloc(4)), /Not a valid PNG/);
});

test('assertImageSize passes at exactly the long-edge limit', () => {
  assert.doesNotThrow(() => assertImageSize({ width: MAX_LONG_EDGE, height: 100 }));
});

test('assertImageSize throws when the long edge exceeds the limit', () => {
  assert.throws(
    () => assertImageSize({ width: MAX_LONG_EDGE + 1, height: 100 }),
    /exceeds 2576px/
  );
});

test('assertImageSize checks height as the long edge too', () => {
  assert.throws(
    () => assertImageSize({ width: 100, height: MAX_LONG_EDGE + 1 }),
    /exceeds 2576px/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/png-size.test.js`
Expected: FAIL — `Cannot find module '../src/png-size'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/png-size.js
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_LONG_EDGE = 2576;

function readPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a valid PNG file (bad signature or too short to hold an IHDR chunk)');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function assertImageSize({ width, height }) {
  const longEdge = Math.max(width, height);
  if (longEdge > MAX_LONG_EDGE) {
    throw new Error(
      `Image long edge ${longEdge}px exceeds ${MAX_LONG_EDGE}px — the vision API would silently ` +
      'resize it and desync the model\'s returned coordinates from the real image. Downscale first.'
    );
  }
}

module.exports = { readPngSize, assertImageSize, MAX_LONG_EDGE };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/png-size.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/png-size.js test/png-size.test.js
git commit -m "feat: add PNG viewport reader and oversized-image guard"
```

---

### Task 3: Ollama provider

**Files:**
- Create: `src/providers/ollama.js`
- Test: `test/providers-ollama.test.js`

**Interfaces:**
- Consumes: `NODE_SCHEMA` from `../scene-schema` (Task 1), `buildPrompt` from `../scene-prompt` (Task 1).
- Produces: `generate(imageBase64: string, opts: {width, height, model?, ollamaUrl?, fetch?}) -> Promise<Array<Node>>`. Task 5 requires this as `providers.ollama.generate`.

- [ ] **Step 1: Write the failing test**

```js
// test/providers-ollama.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { generate } = require('../src/providers/ollama');

function makeFetchMock(nodes) {
  const calls = [];
  const fetchMock = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ message: { content: JSON.stringify({ nodes }) } })
    });
  };
  fetchMock.calls = calls;
  return fetchMock;
}

test('generate posts to /api/chat with the schema, prompt, and low temperature', async () => {
  const fetchMock = makeFetchMock([{ id: 'n0', kind: 'box' }]);
  const nodes = await generate('base64img', {
    width: 390, height: 844, fetch: fetchMock
  });

  assert.equal(fetchMock.calls.length, 1);
  const call = fetchMock.calls[0];
  assert.equal(call.url, 'http://localhost:11434/api/chat');
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, 'qwen2.5vl:7b');
  assert.equal(body.stream, false);
  assert.equal(body.options.temperature, 0.1);
  assert.match(body.messages[0].content, /390x844px/);
  assert.deepEqual(body.messages[0].images, ['base64img']);
  assert.equal(body.format.required[0], 'nodes');
  assert.deepEqual(nodes, [{ id: 'n0', kind: 'box' }]);
});

test('generate honors an overridden model and ollamaUrl', async () => {
  const fetchMock = makeFetchMock([]);
  await generate('img', {
    width: 100, height: 100, model: 'llama3.2-vision:11b',
    ollamaUrl: 'http://192.168.1.50:11434', fetch: fetchMock
  });
  const body = JSON.parse(fetchMock.calls[0].init.body);
  assert.equal(body.model, 'llama3.2-vision:11b');
  assert.equal(fetchMock.calls[0].url, 'http://192.168.1.50:11434/api/chat');
});

test('generate throws a clear error on a non-ok response', async () => {
  const fetchMock = () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') });
  await assert.rejects(
    generate('img', { width: 100, height: 100, fetch: fetchMock }),
    /Ollama request failed: 500 boom/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/providers-ollama.test.js`
Expected: FAIL — `Cannot find module '../src/providers/ollama'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/providers/ollama.js
const { NODE_SCHEMA } = require('../scene-schema');
const { buildPrompt } = require('../scene-prompt');

async function generate(imageBase64, opts) {
  const {
    width,
    height,
    model = 'qwen2.5vl:7b',
    ollamaUrl = 'http://localhost:11434',
    fetch: fetchImpl = fetch
  } = opts;

  const response = await fetchImpl(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildPrompt(width, height), images: [imageBase64] }],
      format: NODE_SCHEMA,
      options: { temperature: 0.1 },
      stream: false
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const parsed = JSON.parse(payload.message.content);
  return parsed.nodes;
}

module.exports = { generate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/providers-ollama.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/ollama.js test/providers-ollama.test.js
git commit -m "feat: add Ollama vision provider"
```

---

### Task 4: OpenAI provider

**Files:**
- Create: `src/providers/openai.js`
- Test: `test/providers-openai.test.js`

**Interfaces:**
- Consumes: `NODE_SCHEMA` from `../scene-schema` (Task 1), `buildPrompt` from `../scene-prompt` (Task 1).
- Produces: `generate(imageBase64: string, opts: {width, height, model?, apiKey?, fetch?}) -> Promise<Array<Node>>`. Same signature shape as Task 3's Ollama provider. Task 5 requires this as `providers.openai.generate`.

- [ ] **Step 1: Write the failing test**

```js
// test/providers-openai.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { generate } = require('../src/providers/openai');

function makeFetchMock(nodes) {
  const calls = [];
  const fetchMock = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ nodes }) } }] })
    });
  };
  fetchMock.calls = calls;
  return fetchMock;
}

test('generate posts to chat/completions with schema, image, and bearer auth', async () => {
  const fetchMock = makeFetchMock([{ id: 'n0', kind: 'text' }]);
  const nodes = await generate('base64img', {
    width: 390, height: 844, apiKey: 'sk-test', fetch: fetchMock
  });

  assert.equal(fetchMock.calls.length, 1);
  const call = fetchMock.calls[0];
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.init.headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.required[0], 'nodes');
  const content = body.messages[0].content;
  assert.match(content[0].text, /390x844px/);
  assert.equal(content[1].image_url.url, 'data:image/png;base64,base64img');
  assert.deepEqual(nodes, [{ id: 'n0', kind: 'text' }]);
});

test('generate honors an overridden model', async () => {
  const fetchMock = makeFetchMock([]);
  await generate('img', { width: 100, height: 100, model: 'gpt-4o', apiKey: 'sk-test', fetch: fetchMock });
  const body = JSON.parse(fetchMock.calls[0].init.body);
  assert.equal(body.model, 'gpt-4o');
});

test('generate throws without an API key', async () => {
  await assert.rejects(
    generate('img', { width: 100, height: 100, apiKey: '', fetch: makeFetchMock([]) }),
    /requires an API key/
  );
});

test('generate throws a clear error on a non-ok response', async () => {
  const fetchMock = () => Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('bad key') });
  await assert.rejects(
    generate('img', { width: 100, height: 100, apiKey: 'sk-test', fetch: fetchMock }),
    /OpenAI request failed: 401 bad key/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/providers-openai.test.js`
Expected: FAIL — `Cannot find module '../src/providers/openai'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/providers/openai.js
const { NODE_SCHEMA } = require('../scene-schema');
const { buildPrompt } = require('../scene-prompt');

async function generate(imageBase64, opts) {
  const {
    width,
    height,
    model = 'gpt-4o-mini',
    apiKey = process.env.OPENAI_API_KEY,
    fetch: fetchImpl = fetch
  } = opts;

  if (!apiKey) {
    throw new Error('OpenAI provider requires an API key — set OPENAI_API_KEY or pass --api-key');
  }

  const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(width, height) },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } }
        ]
      }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'scene', strict: true, schema: NODE_SCHEMA }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const parsed = JSON.parse(payload.choices[0].message.content);
  return parsed.nodes;
}

module.exports = { generate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/providers-openai.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/openai.js test/providers-openai.test.js
git commit -m "feat: add OpenAI vision provider"
```

---

### Task 5: `src/image-scene.js` CLI

**Files:**
- Create: `src/image-scene.js`
- Modify: `package.json` (add `"image"` script)
- Test: `test/image-scene.test.js`

**Interfaces:**
- Consumes: `readPngSize`, `assertImageSize` (Task 2); `providers.ollama.generate`, `providers.openai.generate` (Tasks 3, 4).
- Produces: `fillNodeDefaults(node) -> Node` and `buildScene(nodes, viewport) -> {version, viewport, nodes}` (pure, exported for testing). CLI entry point runs when invoked as `node src/image-scene.js` (guarded by `require.main === module`, matching `src/cli.js`'s pattern) — not required as a library elsewhere in this plan, so nothing downstream consumes the CLI parsing itself.

- [ ] **Step 1: Write the failing test**

```js
// test/image-scene.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { fillNodeDefaults, buildScene } = require('../src/image-scene');

test('fillNodeDefaults adds the wire-format fields a vision model cannot infer', () => {
  const raw = {
    id: 'n0', parentId: null, kind: 'box', name: 'Card / Product',
    x: 10, y: 20, width: 100, height: 50, fill: '#FFFFFF', stroke: null,
    strokeWidth: 0, radius: 4, text: '', fontSize: 0, fontWeight: 400, color: null
  };
  const filled = fillNodeDefaults(raw);
  assert.equal(filled.opacity, 1);
  assert.equal(filled.position, 'static');
  assert.equal(filled.zIndex, 'auto');
  assert.equal(filled.overflow, 'visible');
  assert.equal(filled.lines, 1);
  assert.equal(filled.svg, null);
  assert.equal(filled.borders, null);
  // original fields survive untouched
  assert.equal(filled.id, 'n0');
  assert.equal(filled.name, 'Card / Product');
});

test('buildScene wraps nodes in wire-format v1 with the given viewport', () => {
  const nodes = [{ id: 'n0', kind: 'box' }];
  const scene = buildScene(nodes, { width: 390, height: 844 });
  assert.equal(scene.version, 1);
  assert.deepEqual(scene.viewport, { width: 390, height: 844 });
  assert.equal(scene.nodes.length, 1);
  assert.equal(scene.nodes[0].id, 'n0');
  assert.equal(scene.nodes[0].opacity, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/image-scene.test.js`
Expected: FAIL — `Cannot find module '../src/image-scene'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/image-scene.js
const fs = require('node:fs');
const path = require('node:path');
const { readPngSize, assertImageSize } = require('./png-size');
const ollama = require('./providers/ollama');
const openai = require('./providers/openai');

const PROVIDERS = { ollama, openai };

function fillNodeDefaults(node) {
  return {
    ...node,
    opacity: 1,
    position: 'static',
    zIndex: 'auto',
    overflow: 'visible',
    lines: 1,
    svg: null,
    borders: null
  };
}

function buildScene(nodes, viewport) {
  return { version: 1, viewport, nodes: nodes.map(fillNodeDefaults) };
}

function argument(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const input = process.argv[2];
  if (!input || input.startsWith('-')) {
    console.error(
      'Usage: npm run image -- path/to/shot.png --out scene.json ' +
      '[--provider ollama|openai] [--model NAME] [--ollama-url URL] [--api-key KEY]'
    );
    process.exit(1);
  }

  const providerName = argument('--provider', 'ollama');
  const provider = PROVIDERS[providerName];
  if (!provider) {
    console.error(`Unknown provider "${providerName}" — expected one of: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(path.resolve(input));
  const { width, height } = readPngSize(buffer);
  assertImageSize({ width, height });

  const nodes = await provider.generate(buffer.toString('base64'), {
    width,
    height,
    model: argument('--model', undefined),
    ollamaUrl: argument('--ollama-url', undefined),
    apiKey: argument('--api-key', undefined)
  });

  const scene = buildScene(nodes, { width, height });
  const output = path.resolve(argument('--out', 'scene.json'));
  fs.writeFileSync(output, JSON.stringify(scene, null, 2));
  console.log(`Wrote ${output} (${nodes.length} nodes, provider=${providerName})`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { fillNodeDefaults, buildScene };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/image-scene.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Add the npm script**

Edit `package.json`, add `"image": "node src/image-scene.js"` to `"scripts"`:

```json
{
  "name": "employee-figma-importer",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "test": "node --test",
    "import": "node src/cli.js",
    "plugin": "node src/plugin-cli.js",
    "plugin:package": "node src/plugin-cli.js && node src/plugin-package.js",
    "image": "node src/image-scene.js"
  }
}
```

- [ ] **Step 6: Verify the full suite still passes**

Run: `npm test`
Expected: PASS — all prior suites plus the 5 new test files (Tasks 1–5) pass, no regressions in existing tests.

- [ ] **Step 7: Commit**

```bash
git add src/image-scene.js test/image-scene.test.js package.json
git commit -m "feat: add image-scene CLI wiring providers to wire-format output"
```

---

### Task 6: `bench/compare.js` scorer

**Files:**
- Create: `bench/compare.js`
- Create: `bench/fixtures/README.md`
- Modify: `.gitignore` (ignore generated `scene.*.json` fixture outputs)
- Modify: `package.json` (add `"bench"` script)
- Test: `test/bench-compare.test.js`

**Interfaces:**
- Consumes: nothing from Tasks 1–5 (operates purely on `truth.json`/`scene.json` files matching wire-format v1, which both the existing HTML pipeline and Task 5's CLI already produce).
- Produces: `iou(a, b) -> number`, `colorDelta(hexA, hexB) -> number|null`, `matchNodes(truthNodes, sceneNodes) -> Array<{t, s, score}>`, `normalizeText(text) -> string`, `score(truth, scene) -> {matchedCount, truthCount, sceneCount, precision, recall, meanIou, meanColorDelta, textMatchRate}`. Nothing downstream in this plan consumes these — this is the terminal task.

- [ ] **Step 1: Write the failing test**

```js
// test/bench-compare.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { iou, colorDelta, matchNodes, normalizeText, score } = require('../bench/compare');

test('iou is 1.0 for identical boxes', () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };
  assert.equal(iou(box, box), 1);
});

test('iou is 0 for non-overlapping boxes', () => {
  assert.equal(iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 100, width: 10, height: 10 }), 0);
});

test('iou is between 0 and 1 for partial overlap', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  const b = { x: 5, y: 5, width: 10, height: 10 };
  const result = iou(a, b);
  assert.ok(result > 0 && result < 1, `expected 0 < iou < 1, got ${result}`);
});

test('colorDelta is 0 for identical hex colors', () => {
  assert.equal(colorDelta('#FF5733', '#FF5733'), 0);
});

test('colorDelta is null when either color is missing', () => {
  assert.equal(colorDelta(null, '#FFFFFF'), null);
  assert.equal(colorDelta('#FFFFFF', null), null);
});

test('colorDelta measures Euclidean RGB distance', () => {
  // black vs white: sqrt(255^2 * 3) ≈ 441.67
  const delta = colorDelta('#000000', '#FFFFFF');
  assert.ok(Math.abs(delta - 441.67) < 0.1, `expected ~441.67, got ${delta}`);
});

test('normalizeText collapses whitespace and trims', () => {
  assert.equal(normalizeText('  Hello   World  '), 'Hello World');
  assert.equal(normalizeText(null), '');
});

test('matchNodes greedily assigns highest-IoU pairs of the same kind, one-to-one', () => {
  const truth = [
    { kind: 'box', x: 0, y: 0, width: 10, height: 10 },
    { kind: 'text', x: 0, y: 0, width: 10, height: 10 }
  ];
  const scene = [
    { kind: 'box', x: 0, y: 0, width: 10, height: 10 },
    { kind: 'box', x: 50, y: 50, width: 10, height: 10 }
  ];
  const matches = matchNodes(truth, scene);
  assert.equal(matches.length, 1, 'only the matching-kind, overlapping pair counts');
  assert.equal(matches[0].t, truth[0]);
  assert.equal(matches[0].s, scene[0]);
});

test('matchNodes ignores pairs below the IoU threshold', () => {
  const truth = [{ kind: 'box', x: 0, y: 0, width: 10, height: 10 }];
  const scene = [{ kind: 'box', x: 9, y: 9, width: 10, height: 10 }];
  // small overlap corner — IoU well under 0.3
  assert.equal(matchNodes(truth, scene).length, 0);
});

test('score throws on a viewport mismatch', () => {
  const truth = { viewport: { width: 390, height: 844 }, nodes: [] };
  const scene = { viewport: { width: 400, height: 844 }, nodes: [] };
  assert.throws(() => score(truth, scene), /Viewport mismatch/);
});

test('score aggregates precision, recall, mean IoU, color delta, and text match rate', () => {
  const truth = {
    viewport: { width: 100, height: 100 },
    nodes: [
      { kind: 'box', x: 0, y: 0, width: 10, height: 10, fill: '#000000', color: null, text: '' },
      { kind: 'text', x: 20, y: 20, width: 10, height: 10, fill: null, color: null, text: 'Hello' }
    ]
  };
  const scene = {
    viewport: { width: 100, height: 100 },
    nodes: [
      { kind: 'box', x: 0, y: 0, width: 10, height: 10, fill: '#000000', color: null, text: '' },
      { kind: 'text', x: 20, y: 20, width: 10, height: 10, fill: null, color: null, text: 'Hello' },
      { kind: 'box', x: 90, y: 90, width: 5, height: 5, fill: null, color: null, text: '' }
    ]
  };
  const result = score(truth, scene);
  assert.equal(result.matchedCount, 2);
  assert.equal(result.truthCount, 2);
  assert.equal(result.sceneCount, 3);
  assert.equal(result.recall, 1);
  assert.ok(Math.abs(result.precision - 2 / 3) < 1e-9);
  assert.equal(result.meanIou, 1);
  assert.equal(result.meanColorDelta, 0);
  assert.equal(result.textMatchRate, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bench-compare.test.js`
Expected: FAIL — `Cannot find module '../bench/compare'`

- [ ] **Step 3: Write minimal implementation**

```js
// bench/compare.js
const fs = require('node:fs');
const path = require('node:path');

const MATCH_THRESHOLD = 0.3;

function hexToRgb(hex) {
  if (!hex) return null;
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const value = parseInt(full, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

// ponytail: Euclidean RGB distance, not CIEDE2000 — good enough to tell "close"
// from "wrong" for a first pass. Upgrade to CIEDE2000 (already available in
// .claude/finan-qc/ui-engine/'s venv, a different project, not installed here)
// if this proves misleading against eval-log.md results.
function colorDelta(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return null;
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function iou(a, b) {
  const ax2 = a.x + a.width, ay2 = a.y + a.height;
  const bx2 = b.x + b.width, by2 = b.y + b.height;
  const ix1 = Math.max(a.x, b.x), iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const interW = Math.max(0, ix2 - ix1), interH = Math.max(0, iy2 - iy1);
  const inter = interW * interH;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

function matchNodes(truthNodes, sceneNodes) {
  const candidates = [];
  for (const t of truthNodes) {
    for (const s of sceneNodes) {
      if (t.kind !== s.kind) continue;
      const overlap = iou(t, s);
      if (overlap > MATCH_THRESHOLD) candidates.push({ t, s, score: overlap });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const usedTruth = new Set();
  const usedScene = new Set();
  const matches = [];
  for (const candidate of candidates) {
    if (usedTruth.has(candidate.t) || usedScene.has(candidate.s)) continue;
    usedTruth.add(candidate.t);
    usedScene.add(candidate.s);
    matches.push(candidate);
  }
  return matches;
}

// ponytail: exact-string match after whitespace normalization, no fuzzy/Levenshtein
// distance. Upgrade if OCR-style near-misses (1-2 character drift) dominate the
// error signal in eval-log.md — see .claude/skills/vision-scene-prompt/references/eval-log.md.
function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function score(truth, scene) {
  if (truth.viewport.width !== scene.viewport.width || truth.viewport.height !== scene.viewport.height) {
    throw new Error(
      `Viewport mismatch: truth is ${truth.viewport.width}x${truth.viewport.height}, ` +
      `scene is ${scene.viewport.width}x${scene.viewport.height} — capture the screenshot at the ` +
      'truth viewport before comparing.'
    );
  }

  const matches = matchNodes(truth.nodes, scene.nodes);
  const meanIou = matches.length
    ? matches.reduce((sum, m) => sum + m.score, 0) / matches.length
    : 0;

  const colorDeltas = matches
    .map(m => colorDelta(m.t.fill ?? m.t.color, m.s.fill ?? m.s.color))
    .filter(d => d !== null);
  const meanColorDelta = colorDeltas.length
    ? colorDeltas.reduce((sum, d) => sum + d, 0) / colorDeltas.length
    : null;

  const textPairs = matches.filter(m => m.t.kind === 'text');
  const textMatches = textPairs.filter(m => normalizeText(m.t.text) === normalizeText(m.s.text));
  const textMatchRate = textPairs.length ? textMatches.length / textPairs.length : null;

  return {
    matchedCount: matches.length,
    truthCount: truth.nodes.length,
    sceneCount: scene.nodes.length,
    precision: scene.nodes.length ? matches.length / scene.nodes.length : 0,
    recall: truth.nodes.length ? matches.length / truth.nodes.length : 0,
    meanIou,
    meanColorDelta,
    textMatchRate
  };
}

function argument(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function main() {
  const fixtureDir = process.argv[2];
  if (!fixtureDir || fixtureDir.startsWith('-')) {
    console.error('Usage: node bench/compare.js path/to/fixture-dir --scene scene.provider.json');
    process.exit(1);
  }

  const sceneFile = argument('--scene', 'scene.json');
  const truth = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'truth.json'), 'utf8'));
  const scene = JSON.parse(fs.readFileSync(path.join(fixtureDir, sceneFile), 'utf8'));

  const result = score(truth, scene);
  const colorText = result.meanColorDelta === null ? 'n/a' : result.meanColorDelta.toFixed(1);
  const textMatchText = result.textMatchRate === null ? 'n/a' : `${Math.round(result.textMatchRate * 100)}%`;

  console.log(`Fixtures: 1 screen (${fixtureDir})`);
  console.log(`Score: IoU ${result.meanIou.toFixed(2)}, color ΔE ${colorText}, text-match ${textMatchText}`);
  console.log(
    `Precision ${result.precision.toFixed(2)} (${result.matchedCount}/${result.sceneCount} scene nodes matched) · ` +
    `Recall ${result.recall.toFixed(2)} (${result.matchedCount}/${result.truthCount} truth nodes matched)`
  );
}

if (require.main === module) {
  main();
}

module.exports = { iou, colorDelta, matchNodes, normalizeText, score };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bench-compare.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: Add the npm script**

Edit `package.json`, add `"bench": "node bench/compare.js"` to `"scripts"`:

```json
{
  "name": "employee-figma-importer",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "test": "node --test",
    "import": "node src/cli.js",
    "plugin": "node src/plugin-cli.js",
    "plugin:package": "node src/plugin-cli.js && node src/plugin-package.js",
    "image": "node src/image-scene.js",
    "bench": "node bench/compare.js"
  }
}
```

- [ ] **Step 6: Add the fixtures scaffold and gitignore entry**

Create `bench/fixtures/README.md`:

```markdown
# Bench fixtures

Each subdirectory is one screen used to score the image→Figma vision
pipeline against DOM-derived ground truth.

## Adding a fixture

1. Open `web/index.html`, drop the same HTML file this fixture is for, pick
   the static (non-interactive) capture mode, download the ZIP.
2. Unzip it, copy `scene.json` to `bench/fixtures/<case-name>/truth.json`.
3. Screenshot the same page at **exactly** `truth.json`'s `viewport` width
   and height — a mismatch makes `bench/compare.js` refuse to score it.
   Save as `bench/fixtures/<case-name>/shot.png`.
4. Generate and score:
   ```
   npm run image -- bench/fixtures/<case-name>/shot.png \
     --out bench/fixtures/<case-name>/scene.ollama.json --provider ollama
   npm run bench -- bench/fixtures/<case-name> --scene scene.ollama.json
   ```

`shot.png` and `truth.json` are committed (fixed inputs). Generated
`scene.*.json` files are gitignored — they're reproducible and change every
time the prompt is tuned; see `.claude/skills/vision-scene-prompt/references/eval-log.md`
for the record of what was tried.
```

Add to `.gitignore` (after the existing `__pycache__/` line):

```
bench/fixtures/**/scene.*.json
```

- [ ] **Step 7: Verify the full suite still passes**

Run: `npm test`
Expected: PASS — all existing suites plus all 6 new test files from this plan pass, no regressions.

- [ ] **Step 8: Commit**

```bash
git add bench/compare.js bench/fixtures/README.md test/bench-compare.test.js package.json .gitignore
git commit -m "feat: add bench/compare.js scorer for the vision pipeline"
```

---

## Post-implementation (manual, not part of this plan's tasks)

Per the design spec's environment prerequisites — not automatable, requires user action:

1. `brew install ollama && ollama pull qwen2.5vl:7b` (local provider currently not installed on this machine).
2. `export OPENAI_API_KEY=sk-...` (not currently set).
3. Capture the first real fixture per `bench/fixtures/README.md`, run `npm run image` + `npm run bench`, and append the first entry to `.claude/skills/vision-scene-prompt/references/eval-log.md`.
