# Runtime Self-Learning Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `src/bridge-code.js` remember which structural patterns in captured HTML are known to defeat its rendering (SVG import failure, Figma silently dropping a fill), share that memory across every user via a small backend, and skip straight to the safe handling on the next occurrence instead of failing the same way again.

**Architecture:** `bridge-code.js` (runs inside the Figma plugin sandbox) computes a content-free "signature" for each SVG/fill-bearing scene node, batch-fetches known rules once per rendered state from a Python/FastAPI + Redis backend, applies the known-safe handling when a signature matches, and reports newly-discovered failures back to the same backend. The backend is a thin key-value service: `signature -> fallbackKind`.

**Tech Stack:** Client: vanilla JS (no build step, matches the existing codebase). Backend: Python 3, FastAPI, redis-py (Redis via `REDIS_URL`), pydantic. Backend tests: pytest, fakeredis, httpx (for FastAPI's `TestClient`). Client tests: Node's built-in `node:test` + `node:vm`, matching `test/renderer.test.js`'s existing sandboxing style.

## Global Constraints

- No LLM anywhere in the runtime capture/render path — pure JS heuristics only (spec Section "Phạm vi & giả định").
- Rules auto-apply immediately for every user; there is no approval queue, no rollback, no confidence-decay in this version (spec Section 4).
- v1 touches only `src/bridge-code.js` — `web/plugin-code.js` and `src/template.js` (the other two near-duplicate renderers) are explicitly out of scope; do not edit them (spec Section 1).
- Exactly two `fallbackKind`s get automatic recall-and-apply behavior: `svg-render-failed` and `fill-dropped`. `node-render-failed` (the generic per-node catch) is detect-and-record only — no automatic behavior change (spec Section 3b).
- Backend lives in a new top-level `backend/` directory with its own dependency files; it does not touch `package.json` or `npm test` (spec Section 2).
- Missing/unreachable rules backend must never break rendering — every network call is feature-detected (`typeof fetch === 'function'`) and wrapped so failure silently falls back to today's behavior (spec Section 4).
- Rule signatures must never contain element text/content — only structural shape (spec Section 1).

---

### Task 1: Backend rule store (Redis-backed)

**Files:**
- Create: `backend/requirements.txt`
- Create: `backend/requirements-dev.txt`
- Create: `backend/pytest.ini`
- Create: `backend/store.py`
- Test: `backend/tests/test_store.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `FALLBACK_KINDS: set[str]` (`{"svg-render-failed", "fill-dropped", "node-render-failed"}`); `make_redis_client(url: str | None = None) -> redis.Redis`; `get_rules(client, signatures: list[str]) -> dict[str, dict | None]`; `report_fallback(client, signature: str, fallback_kind: str) -> dict`. Task 2 imports all four from `store`. `backend/pytest.ini` (this task) is what makes `import store` / `import main` resolve in every later test file — Task 2 relies on it too.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_store.py`:

```python
import fakeredis
import pytest

from store import get_rules, report_fallback


@pytest.fixture
def client():
    return fakeredis.FakeRedis(decode_responses=True)


def test_report_fallback_creates_new_record(client):
    record = report_fallback(client, "sig-a", "fill-dropped")
    assert record["signature"] == "sig-a"
    assert record["fallbackKind"] == "fill-dropped"
    assert record["hitCount"] == 1
    assert record["firstSeen"] == record["lastSeen"]


def test_report_fallback_increments_existing_record(client):
    report_fallback(client, "sig-a", "fill-dropped")
    record = report_fallback(client, "sig-a", "fill-dropped")
    assert record["hitCount"] == 2


def test_report_fallback_rejects_unknown_kind(client):
    with pytest.raises(ValueError):
        report_fallback(client, "sig-a", "not-a-real-kind")


def test_get_rules_empty_for_no_signatures(client):
    assert get_rules(client, []) == {}


def test_get_rules_returns_none_for_unknown_signature(client):
    assert get_rules(client, ["sig-a"]) == {"sig-a": None}


def test_get_rules_returns_stored_record(client):
    report_fallback(client, "sig-a", "svg-render-failed")
    result = get_rules(client, ["sig-a"])
    assert result["sig-a"]["fallbackKind"] == "svg-render-failed"
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install fakeredis pytest
pytest tests/test_store.py -v
```
Expected: FAIL/ERROR — `ModuleNotFoundError: No module named 'store'`.

- [ ] **Step 3: Write `backend/pytest.ini`**

Bare `pytest` does not add the current directory to `sys.path` (unlike `python -m pytest`), so without this, `import store` in `backend/tests/test_store.py` fails no matter how the test command is invoked. This makes it resolve regardless of invocation style:

```ini
[pytest]
pythonpath = .
```

- [ ] **Step 4: Write `backend/requirements.txt`**

```
fastapi>=0.110
uvicorn[standard]>=0.29
redis>=5.0
```

- [ ] **Step 5: Write `backend/requirements-dev.txt`**

```
-r requirements.txt
pytest>=8.0
httpx>=0.27
fakeredis>=2.21
```

- [ ] **Step 6: Write `backend/store.py`**

```python
import json
import os
import time
from typing import Iterable

import redis

FALLBACK_KINDS = {"svg-render-failed", "fill-dropped", "node-render-failed"}


def _key(signature: str) -> str:
    return f"rule:{signature}"


def make_redis_client(url: str | None = None) -> "redis.Redis":
    return redis.from_url(url or os.environ["REDIS_URL"], decode_responses=True)


def get_rules(client: "redis.Redis", signatures: Iterable[str]) -> dict:
    signature_list = list(signatures)
    if not signature_list:
        return {}
    values = client.mget([_key(signature) for signature in signature_list])
    return {
        signature: (json.loads(value) if value else None)
        for signature, value in zip(signature_list, values)
    }


def report_fallback(client: "redis.Redis", signature: str, fallback_kind: str) -> dict:
    if fallback_kind not in FALLBACK_KINDS:
        raise ValueError(f"unknown fallbackKind: {fallback_kind}")
    now = time.time()
    existing_raw = client.get(_key(signature))
    if existing_raw:
        record = json.loads(existing_raw)
        record["hitCount"] += 1
        record["lastSeen"] = now
    else:
        record = {
            "signature": signature,
            "fallbackKind": fallback_kind,
            "hitCount": 1,
            "firstSeen": now,
            "lastSeen": now,
        }
    client.set(_key(signature), json.dumps(record))
    return record
```

- [ ] **Step 7: Install dev deps and run tests to verify they pass**

Run:
```bash
pip install -r requirements-dev.txt
pytest tests/test_store.py -v
```
Expected: 6 passed.

- [ ] **Step 8: Commit**

```bash
git add backend/requirements.txt backend/requirements-dev.txt backend/pytest.ini backend/store.py backend/tests/test_store.py
git commit -m "feat(backend): add Redis-backed rule store for the fallback API"
```

---

### Task 2: Backend FastAPI endpoints

**Files:**
- Create: `backend/main.py`
- Test: `backend/tests/test_main.py`

**Interfaces:**
- Consumes: `store.FALLBACK_KINDS`, `store.get_rules`, `store.report_fallback`, `store.make_redis_client` (Task 1).
- Produces: `app` (FastAPI instance), `get_redis_client()` (overridable dependency). `GET /rules?signatures=a,b` -> `{"rules": {"a": {...}|null, "b": {...}|null}}`. `POST /rules` body `{"signature": str, "fallbackKind": str}` -> the stored record (same shape as `store.report_fallback`'s return). Task 3/4 (client) are the HTTP consumers of these two routes; no other Python module imports from `main`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_main.py`:

```python
import fakeredis
from fastapi.testclient import TestClient

from main import app, get_redis_client

fake_client = fakeredis.FakeRedis(decode_responses=True)
app.dependency_overrides[get_redis_client] = lambda: fake_client
client = TestClient(app)


def setup_function():
    fake_client.flushall()


def test_get_rules_returns_null_for_unknown_signature():
    response = client.get("/rules", params={"signatures": "sig-a"})
    assert response.status_code == 200
    assert response.json() == {"rules": {"sig-a": None}}


def test_post_new_rule_creates_record_with_hit_count_1():
    response = client.post("/rules", json={"signature": "sig-a", "fallbackKind": "fill-dropped"})
    assert response.status_code == 200
    body = response.json()
    assert body["signature"] == "sig-a"
    assert body["fallbackKind"] == "fill-dropped"
    assert body["hitCount"] == 1


def test_post_existing_rule_increments_hit_count():
    client.post("/rules", json={"signature": "sig-b", "fallbackKind": "svg-render-failed"})
    response = client.post("/rules", json={"signature": "sig-b", "fallbackKind": "svg-render-failed"})
    assert response.json()["hitCount"] == 2


def test_post_rejects_unknown_fallback_kind():
    response = client.post("/rules", json={"signature": "sig-c", "fallbackKind": "not-real"})
    assert response.status_code == 422


def test_get_rules_after_post_returns_the_rule():
    client.post("/rules", json={"signature": "sig-d", "fallbackKind": "node-render-failed"})
    response = client.get("/rules", params={"signatures": "sig-d,sig-unknown"})
    body = response.json()["rules"]
    assert body["sig-d"]["fallbackKind"] == "node-render-failed"
    assert body["sig-unknown"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_main.py -v`
Expected: FAIL/ERROR — `ModuleNotFoundError: No module named 'main'`.

- [ ] **Step 3: Write `backend/main.py`**

```python
from fastapi import Depends, FastAPI
from pydantic import BaseModel, field_validator

from store import FALLBACK_KINDS, get_rules, make_redis_client, report_fallback

app = FastAPI()


def get_redis_client():
    return make_redis_client()


class ReportFallbackRequest(BaseModel):
    signature: str
    fallbackKind: str

    @field_validator("fallbackKind")
    @classmethod
    def known_fallback_kind(cls, value: str) -> str:
        if value not in FALLBACK_KINDS:
            raise ValueError(f"unknown fallbackKind: {value}")
        return value


@app.get("/rules")
def read_rules(signatures: str = "", client=Depends(get_redis_client)):
    signature_list = [item for item in signatures.split(",") if item]
    return {"rules": get_rules(client, signature_list)}


@app.post("/rules")
def create_or_update_rule(payload: ReportFallbackRequest, client=Depends(get_redis_client)):
    return report_fallback(client, payload.signature, payload.fallbackKind)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_main.py -v`
Expected: 5 passed.

- [ ] **Step 5: Run the whole backend suite**

Run: `pytest -v`
Expected: 11 passed (6 from Task 1 + 5 from this task).

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_main.py
git commit -m "feat(backend): expose GET/POST /rules over the rule store"
```

---

### Task 3: Client — detect and report known fallback sites

**Files:**
- Modify: `src/bridge-code.js:1-2` (insert new consts after), `src/bridge-code.js:114-121` (SVG catch), `src/bridge-code.js:137-142` (fill assignment), `src/bridge-code.js:164-166` (generic catch)
- Test: `test/bridge-code-fallback-rules.test.js` (create)

**Interfaces:**
- Consumes: nothing new from other tasks (self-contained additions to `bridge-code.js`).
- Produces: `RULES_API_BASE` (string constant, reads `RULES_API_BASE_OVERRIDE` if the sandbox defines it), `hasRulesApi()`, `svgSignature(svg)`, `fillSignature(fill)`, `reportFallback(signature, fallbackKind)`. Task 4 consumes `RULES_API_BASE`, `hasRulesApi`, `svgSignature`, `fillSignature` by name — keep them exactly.

- [ ] **Step 1: Write the failing tests**

Create `test/bridge-code-fallback-rules.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/bridge-code.js'), 'utf8');

function makeFetchMock(getRulesResponse) {
  const calls = [];
  const fetchMock = (url, init) => {
    calls.push({ url, init });
    const isGet = !init || !init.method || init.method === 'GET';
    if (isGet) return Promise.resolve({ ok: true, json: () => Promise.resolve(getRulesResponse || { rules: {} }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  fetchMock.calls = calls;
  return fetchMock;
}

function makeFigma() {
  let ids = 0;
  const node = () => {
    const obj = {
      id: 'node-' + (ids += 1), name: '', children: [], owner: null,
      appendChild(child) {
        if (child.owner) child.owner.children.splice(child.owner.children.indexOf(child), 1);
        child.owner = this;
        this.children.push(child);
      },
      resize() {},
      setReactionsAsync() { return Promise.resolve(); },
      _fills: []
    };
    Object.defineProperty(obj, 'fills', {
      get() { return obj._fills; },
      // a real Figma paint with opacity outside [0, 1] is silently rejected — this fake reproduces that
      set(value) { obj._fills = (value || []).filter(paint => paint.opacity >= 0 && paint.opacity <= 1); }
    });
    return obj;
  };
  const messages = [];
  return {
    root: { children: [] },
    createPage() { const page = node(); this.root.children.push(page); return page; },
    createFrame: node,
    createText: node,
    createNodeFromSvg() { throw new Error('Unsupported SVG'); },
    setCurrentPageAsync: () => Promise.resolve(),
    loadFontAsync: () => Promise.resolve(),
    showUI() {},
    notify() {},
    closePlugin() {},
    ui: { postMessage(payload) { messages.push(payload); }, onmessage: null },
    messages
  };
}

function run(figma, extraContext = {}) {
  const context = {
    figma, __html__: '', setTimeout, Map, Set, Promise, Array, Math, Number, JSON, Error, String,
    ...extraContext
  };
  vm.runInNewContext(source, context);
  return context;
}

test('reports svg-render-failed the first time an unknown SVG signature fails', async () => {
  const figma = makeFigma();
  const fetchMock = makeFetchMock();
  run(figma, { RULES_API_BASE_OVERRIDE: 'http://fake.test', fetch: fetchMock });
  figma.ui.onmessage({
    type: 'import', spec: { title: 'T' }, pageName: 'P',
    scene: { version: 1, viewport: { width: 200, height: 200 }, nodes: [
      { id: 'a', parentId: '__root__', kind: 'svg', name: 'icon', x: 0, y: 0, width: 10, height: 10, svg: '<svg/>' }
    ] }
  });
  await new Promise(resolve => setTimeout(resolve, 60));

  const reportCall = fetchMock.calls.find(call => call.init && call.init.method === 'POST');
  assert.ok(reportCall, 'must POST a fallback report');
  assert.match(reportCall.url, /\/rules$/);
  const body = JSON.parse(reportCall.init.body);
  assert.equal(body.signature, 'svg|plain');
  assert.equal(body.fallbackKind, 'svg-render-failed');
});

test('reports fill-dropped when Figma silently rejects an out-of-range fill', async () => {
  const figma = makeFigma();
  const fetchMock = makeFetchMock();
  run(figma, { RULES_API_BASE_OVERRIDE: 'http://fake.test', fetch: fetchMock });
  figma.ui.onmessage({
    type: 'import', spec: { title: 'T' }, pageName: 'P',
    scene: { version: 1, viewport: { width: 200, height: 200 }, nodes: [
      { id: 'a', parentId: '__root__', kind: 'frame', name: 'swatch', x: 0, y: 0, width: 10, height: 10, fill: { r: 0, g: 1, b: 0, a: 1.4 } }
    ] }
  });
  await new Promise(resolve => setTimeout(resolve, 60));

  const reportCall = fetchMock.calls.find(call => call.init && call.init.method === 'POST');
  assert.ok(reportCall, 'must POST a fallback report');
  const body = JSON.parse(reportCall.init.body);
  assert.equal(body.signature, 'fill|alphaOutOfRange:true|hasExtraFields:false');
  assert.equal(body.fallbackKind, 'fill-dropped');
});

test('renders normally with no rules backend configured (no fetch in the sandbox)', async () => {
  const figma = makeFigma();
  run(figma); // no fetch, no RULES_API_BASE_OVERRIDE — matches every pre-existing test's context
  figma.ui.onmessage({
    type: 'import', spec: { title: 'T' }, pageName: 'P',
    scene: { version: 1, viewport: { width: 200, height: 200 }, nodes: [
      { id: 'a', parentId: '__root__', kind: 'svg', name: 'icon', x: 0, y: 0, width: 10, height: 10, svg: '<svg/>' }
    ] }
  });
  await new Promise(resolve => setTimeout(resolve, 60));

  const issues = figma.messages.find(message => message.type === 'render-issues');
  assert.ok(issues, 'the missing-fetch case must still report the render issue exactly as before');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/bridge-code-fallback-rules.test.js`
Expected: first two tests FAIL (`reportCall` is `undefined` — nothing POSTs yet); third test PASSES already (matches current behavior).

- [ ] **Step 3: Add the new consts to `src/bridge-code.js`**

Insert after line 2 (`const fontStyle = weight => ...`):

```js
const RULES_API_BASE = typeof RULES_API_BASE_OVERRIDE !== 'undefined' ? RULES_API_BASE_OVERRIDE : 'REPLACE_WITH_DEPLOYED_RULES_API_URL';
const hasRulesApi = () => typeof fetch === 'function';

const SVG_FALLBACK_FEATURES = ['filter', 'clipPath', 'mask', 'foreignObject', 'use', 'symbol'];
const svgSignature = svg => {
  const present = SVG_FALLBACK_FEATURES.filter(tag => new RegExp('<' + tag, 'i').test(svg || ''));
  return 'svg|' + (present.length ? present.join(',') : 'plain');
};
const fillSignature = fill => {
  const alphaOutOfRange = typeof fill.a === 'number' && (fill.a < 0 || fill.a > 1);
  const hasExtraFields = Object.keys(fill).some(key => key !== 'r' && key !== 'g' && key !== 'b' && key !== 'a');
  return 'fill|alphaOutOfRange:' + alphaOutOfRange + '|hasExtraFields:' + hasExtraFields;
};

function reportFallback(signature, fallbackKind) {
  if (!hasRulesApi()) return;
  try {
    fetch(RULES_API_BASE + '/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature, fallbackKind })
    }).catch(() => {});
  } catch (error) { /* no rules backend reachable — same as a network error */ }
}
```

- [ ] **Step 4: Wire `reportFallback` into the three existing issue sites**

Replace the SVG catch (currently lines 114-120):
```js
        try { return figma.createNodeFromSvg(item.svg); }
        catch (error) {
          issues.push({ name: item.name || item.kind, kind: item.kind, message: error.message });
          const placeholder = figma.createFrame();
          placeholder.fills = [];
          return placeholder;
        }
```
with:
```js
        try { return figma.createNodeFromSvg(item.svg); }
        catch (error) {
          issues.push({ name: item.name || item.kind, kind: item.kind, message: error.message });
          reportFallback(svgSignature(item.svg), 'svg-render-failed');
          const placeholder = figma.createFrame();
          placeholder.fills = [];
          return placeholder;
        }
```

Replace the fill-dropped check (currently line 142):
```js
        if (item.fill && !(node.fills && node.fills.length)) issues.push({ name: node.name, kind: 'fill', message: 'Figma bỏ fill ' + JSON.stringify(item.fill) });
```
with:
```js
        if (item.fill && !(node.fills && node.fills.length)) {
          issues.push({ name: node.name, kind: 'fill', message: 'Figma bỏ fill ' + JSON.stringify(item.fill) });
          reportFallback(fillSignature(item.fill), 'fill-dropped');
        }
```

Replace the generic per-node catch (currently lines 164-166):
```js
    } catch (error) {
      issues.push({ name: item.name || item.kind, kind: item.kind, message: error.message });
    }
```
with:
```js
    } catch (error) {
      issues.push({ name: item.name || item.kind, kind: item.kind, message: error.message });
      reportFallback(item.kind + '|generic', 'node-render-failed');
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/bridge-code-fallback-rules.test.js`
Expected: 3 passed.

- [ ] **Step 6: Run the full existing test suite for a regression check**

Run: `npm test`
Expected: all existing tests still pass (no `fetch` in their sandboxes means `hasRulesApi()` is `false`, so `reportFallback` is a no-op for every one of them).

- [ ] **Step 7: Commit**

```bash
git add src/bridge-code.js test/bridge-code-fallback-rules.test.js
git commit -m "feat: report known-fallback signatures to the rules backend"
```

---

### Task 4: Client — recall known rules and skip the failure

**Files:**
- Modify: `src/bridge-code.js:73-101` (top of `renderScene`, before the node loop), `src/bridge-code.js:111-121` (SVG `build()`), `src/bridge-code.js:137-142` (fill assignment)
- Modify: `test/bridge-code-fallback-rules.test.js` (append tests)

**Interfaces:**
- Consumes: `RULES_API_BASE`, `hasRulesApi()`, `svgSignature(svg)`, `fillSignature(fill)` (Task 3).
- Produces: `fetchKnownRules(signatures: string[]) -> Promise<Map<string, string>>` (maps signature to `fallbackKind`), `clampFill(fill)`. `rules` (a `Map` in scope for the rest of `renderScene`) is not consumed elsewhere — it is local to this function.

- [ ] **Step 1: Write the failing tests (append to `test/bridge-code-fallback-rules.test.js`)**

```js
test('skips a known-bad SVG without calling createNodeFromSvg or re-reporting it', async () => {
  const figma = makeFigma();
  figma.createNodeFromSvg = () => { throw new Error('must not be called'); };
  const fetchMock = makeFetchMock({ rules: { 'svg|plain': { signature: 'svg|plain', fallbackKind: 'svg-render-failed', hitCount: 3, firstSeen: 1, lastSeen: 2 } } });
  run(figma, { RULES_API_BASE_OVERRIDE: 'http://fake.test', fetch: fetchMock });
  figma.ui.onmessage({
    type: 'import', spec: { title: 'T' }, pageName: 'P',
    scene: { version: 1, viewport: { width: 200, height: 200 }, nodes: [
      { id: 'a', parentId: '__root__', kind: 'svg', name: 'icon', x: 0, y: 0, width: 10, height: 10, svg: '<svg/>' }
    ] }
  });
  await new Promise(resolve => setTimeout(resolve, 60));

  const reportCalls = fetchMock.calls.filter(call => call.init && call.init.method === 'POST');
  assert.equal(reportCalls.length, 0, 'a known signature must not be re-reported');
  const root = figma.root.children[0]?.children[0];
  assert.ok(root, 'the state frame must still exist');
});

test('clamps a known-bad fill instead of losing it', async () => {
  const figma = makeFigma();
  const signature = 'fill|alphaOutOfRange:true|hasExtraFields:false';
  const fetchMock = makeFetchMock({ rules: { [signature]: { signature, fallbackKind: 'fill-dropped', hitCount: 2, firstSeen: 1, lastSeen: 2 } } });
  run(figma, { RULES_API_BASE_OVERRIDE: 'http://fake.test', fetch: fetchMock });
  figma.ui.onmessage({
    type: 'import', spec: { title: 'T' }, pageName: 'P',
    scene: { version: 1, viewport: { width: 200, height: 200 }, nodes: [
      { id: 'a', parentId: '__root__', kind: 'frame', name: 'swatch', x: 0, y: 0, width: 10, height: 10, fill: { r: 0, g: 1, b: 0, a: 1.4 } }
    ] }
  });
  await new Promise(resolve => setTimeout(resolve, 60));

  const swatch = figma.root.children[0]?.children[0]?.children.find(child => child.name === 'swatch');
  assert.ok(swatch, 'the swatch frame must exist');
  assert.equal(swatch.fills.length, 1, 'the clamped fill must survive assignment instead of being dropped');
  const reportCalls = fetchMock.calls.filter(call => call.init && call.init.method === 'POST');
  assert.equal(reportCalls.length, 0, 'a known signature must not be re-reported');
});

test('fetches known rules once per state, not once per node', async () => {
  const figma = makeFigma();
  const fetchMock = makeFetchMock({ rules: {} });
  run(figma, { RULES_API_BASE_OVERRIDE: 'http://fake.test', fetch: fetchMock });
  const nodes = Array.from({ length: 5 }, (_, index) => ({
    id: 'n' + index, parentId: '__root__', kind: 'svg', name: 'icon' + index, x: 0, y: 0, width: 10, height: 10, svg: '<svg/>'
  }));
  figma.ui.onmessage({ type: 'import', spec: { title: 'T' }, pageName: 'P', scene: { version: 1, viewport: { width: 200, height: 200 }, nodes } });
  await new Promise(resolve => setTimeout(resolve, 60));

  const getCalls = fetchMock.calls.filter(call => !call.init || !call.init.method || call.init.method === 'GET');
  assert.equal(getCalls.length, 1, 'must batch one GET for the whole state, not one per node');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/bridge-code-fallback-rules.test.js`
Expected: the 3 new tests FAIL — `createNodeFromSvg` still gets called (throws "must not be called"), the fill is still dropped, and no GET call exists yet.

- [ ] **Step 3: Add `fetchKnownRules` and `clampFill` next to the Task 3 consts**

Insert right after the `reportFallback` function from Task 3:

```js
const clampFill = fill => ({ r: fill.r, g: fill.g, b: fill.b, a: Math.max(0, Math.min(1, fill.a ?? 1)) });

async function fetchKnownRules(signatures) {
  const unique = [...new Set(signatures)];
  if (!unique.length || !hasRulesApi()) return new Map();
  try {
    const response = await fetch(RULES_API_BASE + '/rules?signatures=' + encodeURIComponent(unique.join(',')));
    if (!response.ok) return new Map();
    const body = await response.json();
    return new Map(
      Object.entries(body.rules || {})
        .filter(([, rule]) => rule)
        .map(([signature, rule]) => [signature, rule.fallbackKind])
    );
  } catch (error) {
    return new Map();
  }
}
```

- [ ] **Step 4: Fetch rules once at the top of `renderScene`, before the node loop**

Replace (currently lines 99-101):
```js
  await figma.setCurrentPageAsync(page);
  if (spot.section) await sectionLabel(page, spot, depth);
  for (let index = 0; index < scene.nodes.length; index += 1) {
```
with:
```js
  await figma.setCurrentPageAsync(page);
  if (spot.section) await sectionLabel(page, spot, depth);
  const rules = await fetchKnownRules(
    scene.nodes
      .filter(item => item.kind === 'svg' || item.fill)
      .map(item => item.kind === 'svg' ? svgSignature(item.svg) : fillSignature(item.fill))
  );
  for (let index = 0; index < scene.nodes.length; index += 1) {
```

- [ ] **Step 5: Skip the known-bad SVG path inside `build()`**

Replace (currently lines 111-121, already carrying Task 3's `reportFallback` call):
```js
      const build = () => {
        if (item.kind === 'text') return figma.createText();
        if (item.kind !== 'svg') return figma.createFrame();
        try { return figma.createNodeFromSvg(item.svg); }
        catch (error) {
          issues.push({ name: item.name || item.kind, kind: item.kind, message: error.message });
          reportFallback(svgSignature(item.svg), 'svg-render-failed');
          const placeholder = figma.createFrame();
          placeholder.fills = [];
          return placeholder;
        }
      };
```
with:
```js
      const build = () => {
        if (item.kind === 'text') return figma.createText();
        if (item.kind !== 'svg') return figma.createFrame();
        if (rules.get(svgSignature(item.svg)) === 'svg-render-failed') {
          issues.push({ name: item.name || item.kind, kind: item.kind, message: 'SVG này đã biết trước không render được (bỏ qua sớm).' });
          const placeholder = figma.createFrame();
          placeholder.fills = [];
          return placeholder;
        }
        try { return figma.createNodeFromSvg(item.svg); }
        catch (error) {
          issues.push({ name: item.name || item.kind, kind: item.kind, message: error.message });
          reportFallback(svgSignature(item.svg), 'svg-render-failed');
          const placeholder = figma.createFrame();
          placeholder.fills = [];
          return placeholder;
        }
      };
```

- [ ] **Step 6: Clamp the known-bad fill before assigning it**

Replace (currently line 140-142, already carrying Task 3's `reportFallback` call):
```js
        node.fills = item.fill ? [solid(item.fill)] : [];
        // A fill Figma accepts but does not keep leaves a see-through frame and no error — say so.
        if (item.fill && !(node.fills && node.fills.length)) {
          issues.push({ name: node.name, kind: 'fill', message: 'Figma bỏ fill ' + JSON.stringify(item.fill) });
          reportFallback(fillSignature(item.fill), 'fill-dropped');
        }
```
with:
```js
        const fillValue = item.fill && rules.get(fillSignature(item.fill)) === 'fill-dropped' ? clampFill(item.fill) : item.fill;
        node.fills = fillValue ? [solid(fillValue)] : [];
        // A fill Figma accepts but does not keep leaves a see-through frame and no error — say so.
        if (fillValue && !(node.fills && node.fills.length)) {
          issues.push({ name: node.name, kind: 'fill', message: 'Figma bỏ fill ' + JSON.stringify(item.fill) });
          reportFallback(fillSignature(item.fill), 'fill-dropped');
        }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/bridge-code-fallback-rules.test.js`
Expected: 6 passed (3 from Task 3 + 3 new).

- [ ] **Step 8: Run the full existing test suite for a regression check**

Run: `npm test`
Expected: all existing tests still pass — none of them set `RULES_API_BASE_OVERRIDE`/`fetch`, so `fetchKnownRules` returns an empty `Map` immediately and every lookup falls through to today's original behavior.

- [ ] **Step 9: Commit**

```bash
git add src/bridge-code.js test/bridge-code-fallback-rules.test.js
git commit -m "feat: recall known-bad signatures and skip straight to the safe handling"
```

---

### Task 5: Wire up plugin network access and document the deploy step

**Files:**
- Modify: `src/plugin-bundle.js:14` (the `networkAccess` line)
- Modify: `test/plugin-bundle.test.js` (add one assertion)
- Modify: `README.md` (add a short deploy note)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by other tasks — this is the last task.

- [ ] **Step 1: Write the failing test**

Add to `test/plugin-bundle.test.js`, inside the existing `test('creates a Figma plugin bundle that imports from its own UI', ...)` body, right after the existing `assert.equal(bundle.manifest.documentAccess, 'dynamic-page');` line:

```js
  assert.deepEqual(bundle.manifest.networkAccess, { allowedDomains: ['REPLACE_WITH_DEPLOYED_RULES_API_HOST'] });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/plugin-bundle.test.js`
Expected: FAIL — actual value is `{ allowedDomains: ['none'] }`.

- [ ] **Step 3: Update `src/plugin-bundle.js`**

Replace:
```js
      networkAccess: { allowedDomains: ['none'] },
```
with:
```js
      // Replace with the real host once backend/ is deployed (see README.md "Runtime self-learning
      // fallback backend"); must match the host embedded in RULES_API_BASE in src/bridge-code.js.
      networkAccess: { allowedDomains: ['REPLACE_WITH_DEPLOYED_RULES_API_HOST'] },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/plugin-bundle.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Add a deploy note to `README.md`**

Add this section right before the existing `## Deploy to Vercel` heading:

```markdown
## Runtime self-learning fallback backend (optional)

`src/bridge-code.js` can recall which SVG/fill patterns are known to fail
rendering, shared across every user via a small backend in `backend/`. It is
optional — with no backend configured, rendering behaves exactly as before.

To enable it:

1. Deploy `backend/` (FastAPI) anywhere that can reach a Redis instance, with
   `REDIS_URL` set. Locally: `cd backend && pip install -r requirements-dev.txt
   && REDIS_URL=redis://localhost:6379 uvicorn main:app --reload`.
2. In `src/bridge-code.js`, replace `RULES_API_BASE`'s placeholder
   (`REPLACE_WITH_DEPLOYED_RULES_API_URL`) with the deployed URL.
3. In `src/plugin-bundle.js`, replace `networkAccess.allowedDomains`'s
   placeholder (`REPLACE_WITH_DEPLOYED_RULES_API_HOST`) with that same host.
4. Rebuild the plugin (`npm run plugin` / `npm run plugin:package`).

```

- [ ] **Step 7: Commit**

```bash
git add src/plugin-bundle.js test/plugin-bundle.test.js README.md
git commit -m "feat: gate the fallback backend behind explicit deploy placeholders"
```

## Self-Review Notes

- **Spec coverage:** Detection layer (Section 1) → Task 3. Rule schema/backend (Section 2) → Tasks 1-2. Runtime consumption flow (Section 3) → Task 4. Fixed per-`fallbackKind` handling (Section 3b) → Task 4 steps 5-6. Error handling / no-crash-on-missing-backend (Section 4) → Task 3 step 1's third test + Task 4 step 8. Testing (Section 5) → every task's own test file. `node-render-failed` staying detect-only → Task 3 step 4's generic-catch edit adds `reportFallback` but Task 4 never gives it a recall path. Out-of-scope items (the other 2 renderers, TS migration, LLM, rollback) are named in Global Constraints and never touched by any task.
- **Type/signature consistency:** `svgSignature`, `fillSignature`, `hasRulesApi`, `RULES_API_BASE` are defined once in Task 3 and referenced by the same names in Task 4 — checked against Task 4's exact code blocks. `fetchKnownRules` returns `Map<string, string>` (signature → fallbackKind, not the full record) — Task 4's usage (`rules.get(...) === 'svg-render-failed'`) matches that shape, not the raw backend record shape from Task 1/2.
- **Placeholder scan:** no "TBD"/"TODO" left; the two literal strings `REPLACE_WITH_DEPLOYED_RULES_API_URL` / `REPLACE_WITH_DEPLOYED_RULES_API_HOST` are intentional, tested placeholders (Task 5 asserts the exact string), not stand-ins for missing plan content.
