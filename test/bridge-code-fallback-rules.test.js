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

test('skips a known-bad SVG with a risky feature without calling createNodeFromSvg or re-reporting it', async () => {
  const figma = makeFigma();
  figma.createNodeFromSvg = () => { throw new Error('must not be called'); };
  const signature = 'svg|filter';
  const fetchMock = makeFetchMock({ rules: { [signature]: { signature, fallbackKind: 'svg-render-failed', hitCount: 3, firstSeen: 1, lastSeen: 2 } } });
  run(figma, { RULES_API_BASE_OVERRIDE: 'http://fake.test', fetch: fetchMock });
  figma.ui.onmessage({
    type: 'import', spec: { title: 'T' }, pageName: 'P',
    scene: { version: 1, viewport: { width: 200, height: 200 }, nodes: [
      { id: 'a', parentId: '__root__', kind: 'svg', name: 'icon', x: 0, y: 0, width: 10, height: 10, svg: '<svg><filter/></svg>' }
    ] }
  });
  await new Promise(resolve => setTimeout(resolve, 60));

  const reportCalls = fetchMock.calls.filter(call => call.init && call.init.method === 'POST');
  assert.equal(reportCalls.length, 0, 'a known signature must not be re-reported');
  const root = figma.root.children[0]?.children[0];
  assert.ok(root, 'the state frame must still exist');
});

test('never auto-skips the svg|plain bucket even with a matching known-bad rule', async () => {
  const figma = makeFigma();
  let createNodeFromSvgCalls = 0;
  figma.createNodeFromSvg = () => { createNodeFromSvgCalls += 1; throw new Error('still fails, but must still be attempted'); };
  const fetchMock = makeFetchMock({ rules: { 'svg|plain': { signature: 'svg|plain', fallbackKind: 'svg-render-failed', hitCount: 50, firstSeen: 1, lastSeen: 2 } } });
  run(figma, { RULES_API_BASE_OVERRIDE: 'http://fake.test', fetch: fetchMock });
  figma.ui.onmessage({
    type: 'import', spec: { title: 'T' }, pageName: 'P',
    scene: { version: 1, viewport: { width: 200, height: 200 }, nodes: [
      { id: 'a', parentId: '__root__', kind: 'svg', name: 'icon', x: 0, y: 0, width: 10, height: 10, svg: '<svg><rect/></svg>' }
    ] }
  });
  await new Promise(resolve => setTimeout(resolve, 60));

  assert.equal(createNodeFromSvgCalls, 1, 'svg|plain must never be proactively skipped, no matter what the rule says');
  // the actual failure still reports — recall is restricted, reporting is not.
  const reportCall = fetchMock.calls.find(call => call.init && call.init.method === 'POST');
  assert.ok(reportCall, 'the real failure must still be reported even though it was not proactively skipped');
  const body = JSON.parse(reportCall.init.body);
  assert.equal(body.signature, 'svg|plain');
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

test('reports a repeated failing signature at most once per renderScene call', async () => {
  const figma = makeFigma();
  figma.createNodeFromSvg = () => { throw new Error('always fails'); };
  const fetchMock = makeFetchMock({ rules: {} });
  run(figma, { RULES_API_BASE_OVERRIDE: 'http://fake.test', fetch: fetchMock });
  const nodes = Array.from({ length: 5 }, (_, index) => ({
    id: 'n' + index, parentId: '__root__', kind: 'svg', name: 'icon' + index, x: 0, y: 0, width: 10, height: 10, svg: '<svg><filter/></svg>'
  }));
  figma.ui.onmessage({ type: 'import', spec: { title: 'T' }, pageName: 'P', scene: { version: 1, viewport: { width: 200, height: 200 }, nodes } });
  await new Promise(resolve => setTimeout(resolve, 60));

  const reportCalls = fetchMock.calls.filter(call => call.init && call.init.method === 'POST');
  assert.equal(reportCalls.length, 1, 'five nodes sharing one failing signature must send exactly one POST');
  const body = JSON.parse(reportCalls[0].init.body);
  assert.equal(body.signature, 'svg|filter');
});
