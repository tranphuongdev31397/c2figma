const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const renderers = [
  '../src/bridge-code.js',
  '../src/template.js',
  '../web/plugin-code.js'
];

test('keeps captured text on one line when Figma font metrics are wider', () => {
  for (const file of renderers) {
    assert.match(fs.readFileSync(require.resolve(file), 'utf8'), /WIDTH_AND_HEIGHT/);
  }
});

test('renders captured SVG layers through Figma SVG import', () => {
  for (const file of renderers) {
    assert.match(fs.readFileSync(require.resolve(file), 'utf8'), /createNodeFromSvg/);
  }
});

test('raises positioned layers above normal siblings', () => {
  for (const file of renderers) {
    assert.match(fs.readFileSync(require.resolve(file), 'utf8'), /item\.position\s*===\s*'absolute'/);
  }
});

test('hoists z-indexed layers out of the container that would bury them', () => {
  for (const file of renderers) {
    const source = fs.readFileSync(require.resolve(file), 'utf8');
    assert.match(source, /stackLevel/, file + ' must detect z-indexed overlays');
    assert.match(source, /compareStack/, file + ' must order overlays by stacking level');
  }
});

// A dropdown is absolute + z-index inside a table container; the sheet is a fixed portal. Both have to
// end up above what follows them in the DOM, and a menu inside the sheet above the sheet.
const stackingScene = () => ({
  version: 1,
  viewport: { width: 1440, height: 900 },
  nodes: [
    { id: 'panel', parentId: '__root__', kind: 'frame', name: 'panel', x: 0, y: 0, width: 1400, height: 800, position: 'relative', zIndex: 'auto', overflow: 'hidden' },
    { id: 'wrap', parentId: 'panel', kind: 'frame', name: 'fc-wrap', x: 400, y: 100, width: 100, height: 30, position: 'relative', zIndex: 'auto' },
    { id: 'drop', parentId: 'wrap', kind: 'frame', name: 'fc-drop', x: 411, y: 139, width: 243, height: 118, position: 'absolute', zIndex: '50' },
    { id: 'cell', parentId: 'panel', kind: 'frame', name: 'Cell', x: 25, y: 197, width: 495, height: 65, position: 'static', zIndex: 'auto' },
    { id: 'portal', parentId: '__root__', kind: 'frame', name: 'portal', x: 0, y: 0, width: 1440, height: 900, position: 'fixed', zIndex: '60' },
    { id: 'backdrop', parentId: 'portal', kind: 'frame', name: 'backdrop', x: 0, y: 0, width: 1440, height: 900, position: 'absolute', zIndex: 'auto' },
    { id: 'sheet', parentId: 'portal', kind: 'frame', name: 'sheet', x: 868, y: 12, width: 560, height: 876, position: 'absolute', zIndex: 'auto' },
    { id: 'menu', parentId: 'sheet', kind: 'frame', name: 'sheet menu', x: 900, y: 200, width: 200, height: 100, position: 'absolute', zIndex: '50' }
  ]
});

test('renders a dropdown above the table it overlaps, and a dialog above both', async () => {
  let ids = 0;
  const node = () => ({
    id: 'node-' + (ids += 1),
    name: '',
    children: [],
    owner: null,
    appendChild(child) {
      if (child.owner) child.owner.children.splice(child.owner.children.indexOf(child), 1);
      child.owner = this;
      this.children.push(child);
    },
    resize() {},
    setReactionsAsync() { return Promise.resolve(); }
  });
  const figma = {
    root: { children: [] },
    createPage() { const page = node(); this.root.children.push(page); return page; },
    createFrame: node,
    createText: node,
    createNodeFromSvg: node,
    setCurrentPageAsync: () => Promise.resolve(),
    loadFontAsync: () => Promise.resolve(),
    showUI() {},
    notify() {},
    closePlugin() {},
    ui: { postMessage() {}, onmessage: null }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/bridge-code.js'), 'utf8'), {
    figma, __html__: '', setTimeout, Map, Set, Promise, Array, Math, Number, JSON, Error, String
  });
  figma.ui.onmessage({ type: 'import', spec: { title: 'T' }, pageName: 'P', scene: stackingScene() });
  await new Promise(resolve => setTimeout(resolve, 60));

  const paintOrder = [];
  const walk = parent => { for (const child of parent.children) { paintOrder.push(child.name); walk(child); } };
  walk(figma.root.children[0].children[0]);
  const at = name => paintOrder.indexOf(name);

  assert.ok(at('fc-drop') > at('Cell'), 'the dropdown must paint after the table cell it overlaps');
  assert.ok(at('fc-drop') < at('portal'), 'z-index 50 stays below the z-index 60 dialog portal');
  assert.ok(at('sheet') > at('backdrop'), 'the dialog must not sit under its own dimming backdrop');
  assert.ok(at('sheet menu') > at('sheet'), 'a menu inside the dialog paints above the dialog');
});

// A single layer Figma refuses to build used to abort the whole state, leaving the empty white frame
// the render had already created — the "blank modal" report.
test('keeps rendering the rest of a state when one layer fails to build', async () => {
  let ids = 0;
  const node = () => ({
    id: 'node-' + (ids += 1),
    name: '',
    children: [],
    owner: null,
    appendChild(child) { if (child.owner) child.owner.children.splice(child.owner.children.indexOf(child), 1); child.owner = this; this.children.push(child); },
    resize() {},
    setReactionsAsync() { return Promise.resolve(); }
  });
  const messages = [];
  const figma = {
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
    ui: { postMessage(payload) { messages.push(payload); }, onmessage: null }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/bridge-code.js'), 'utf8'), {
    figma, __html__: '', setTimeout, Map, Set, Promise, Array, Math, Number, JSON, Error, String
  });
  figma.ui.onmessage({
    type: 'import',
    spec: { title: 'T' },
    pageName: 'P',
    scene: {
      version: 1,
      viewport: { width: 200, height: 200 },
      nodes: [
        { id: 'a', parentId: '__root__', kind: 'frame', name: 'panel', x: 0, y: 0, width: 200, height: 200 },
        { id: 'b', parentId: 'a', kind: 'svg', name: 'broken icon', x: 0, y: 0, width: 10, height: 10, svg: '<svg/>' },
        { id: 'c', parentId: 'a', kind: 'frame', name: 'checkbox', x: 20, y: 20, width: 18, height: 18, fill: { r: 0, g: 1, b: 0, a: 1 } }
      ]
    }
  });
  await new Promise(resolve => setTimeout(resolve, 60));

  const root = figma.root.children[0]?.children[0];
  const names = [];
  const walk = parent => { for (const child of parent.children) { names.push(child.name); walk(child); } };
  assert.ok(root, 'the state frame must exist');
  walk(root);
  assert.ok(names.includes('checkbox'), 'layers after the failing one must still render, not leave a blank frame');
  const issues = messages.find(message => message.type === 'render-issues');
  assert.ok(issues, 'the failing layer must be reported instead of swallowed');
  assert.match(JSON.stringify(issues), /broken icon/, 'the report must name the layer that failed');
});

test('every renderer wraps states into rows and survives a failing layer', () => {
  for (const file of renderers) {
    const source = fs.readFileSync(require.resolve(file), 'utf8');
    assert.match(source, /placeState/, file + ' must lay states out in a grid');
    assert.match(source, /ROW_GAP/, file + ' must space the rows');
    assert.match(source, /issues/, file + ' must collect per-layer failures instead of aborting');
  }
});

test('clips only frames whose HTML overflow clips content', () => {
  for (const file of renderers) {
    assert.match(fs.readFileSync(require.resolve(file), 'utf8'), /clipsContent/);
    assert.match(fs.readFileSync(require.resolve(file), 'utf8'), /item\.overflow/);
  }
});

test('renders border weights independently per side', () => {
  for (const file of renderers) {
    assert.match(fs.readFileSync(require.resolve(file), 'utf8'), /strokeBottomWeight/);
  }
});

test('uses a collision-safe page name and yields progress while rendering', () => {
  for (const file of renderers) {
    const source = fs.readFileSync(require.resolve(file), 'utf8');
    assert.match(source, /uniquePageName/);
    assert.match(source, /setTimeout/);
  }
});

test('direct renderer accepts streamed states and links prototype actions', () => {
  const source = fs.readFileSync(require.resolve('../src/bridge-code.js'), 'utf8');

  for (const term of ['import-start', 'import-state', 'import-finish', 'setReactionsAsync', 'actionNodes', 'destinationId', 'ON_CLICK']) {
    assert.match(source, new RegExp(term));
  }
  assert.match(source, /transition.*skipped/i);
  assert.match(source, /message\.type\s*!==\s*['"]import['"]/);
});

test('generated plugin renderers mirror the completed-graph contract', () => {
  for (const file of ['../src/template.js', '../web/plugin-code.js']) {
    const source = fs.readFileSync(require.resolve(file), 'utf8');
    for (const term of ['setReactionsAsync', 'actionKey', 'destinationId', 'DISSOLVE', 'state-progress']) {
      assert.match(source, new RegExp(term), file + ' is missing ' + term);
    }
  }
});

const graphFixture = () => {
  const scene = actionKey => ({
    version: 1,
    viewport: { width: 100, height: 100 },
    nodes: [{ id: 'n1', parentId: '__root__', kind: 'frame', name: 'Row', x: 0, y: 0, width: 10, height: 10, actionKey }]
  });
  return {
    version: 2,
    states: [
      { id: 'state-00', label: 'Default', scene: scene('a1') },
      { id: 'state-01', label: 'Opened', scene: scene(null) }
    ],
    transitions: [{ from: 'state-00', to: 'state-01', actionKey: 'a1', trigger: 'ON_CLICK' }]
  };
};

const fakeFigma = (reactions, { uiVisible = true } = {}) => {
  let ids = 0;
  const node = () => ({
    id: 'node-' + (ids += 1),
    children: [],
    appendChild(child) { this.children.push(child); },
    resize() {},
    setReactionsAsync(value) { reactions.push({ id: this.id, value }); return Promise.resolve(); }
  });
  const closed = [];
  return {
    closed,
    figma: {
      root: { children: [] },
      createPage() { const page = node(); this.root.children.push(page); return page; },
      createFrame: node,
      createText: node,
      createNodeFromSvg: node,
      setCurrentPageAsync: () => Promise.resolve(),
      loadFontAsync: () => Promise.resolve(),
      showUI() {},
      notify() {},
      closePlugin(message) { closed.push(message); },
      ui: {
        postMessage() { if (!uiVisible) throw new Error('no visible UI'); },
        onmessage: null
      }
    }
  };
};

test('generated plugins render every state and link prototype reactions', async () => {
  const generators = [
    () => require('../src/template').pluginCode({ title: 'T', pageName: 'Employees', graph: graphFixture() }),
    () => {
      const scope = { window: {} };
      vm.runInNewContext(fs.readFileSync(require.resolve('../web/plugin-code.js'), 'utf8'), scope);
      return scope.window.pluginCode(null, 'Employees', 'T') + '\nconst STATE_GRAPH = ' + JSON.stringify(graphFixture()) + ';\n';
    }
  ];

  for (const generate of generators) {
    const reactions = [];
    // the generated ZIP plugin ships no ui.html, so its UI messages must not reach a visible UI
    const { figma, closed } = fakeFigma(reactions, { uiVisible: false });
    vm.runInNewContext(generate(), { figma, __html__: '', setTimeout, Map, Set, Promise, Array, Math, JSON, Error, String });
    await new Promise(resolve => setTimeout(resolve, 50));

    const [page] = figma.root.children;
    assert.equal(figma.root.children.length, 1, 'every state belongs on one page');
    assert.equal(page.name, 'Employees');
    const frames = page.children.filter(child => /^State \//.test(child.name || ''));
    assert.equal(frames.length, 2, 'one root frame per state');
    assert.ok(frames[1].x >= frames[0].x + 100, 'state frames must not overlap');
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].value[0].trigger.type, 'ON_CLICK');
    assert.equal(reactions[0].value[0].actions[0].transition.type, 'DISSOLVE');
    assert.ok(reactions[0].value[0].actions[0].destinationId);
    assert.deepEqual(closed, ['Đã tạo design editable từ HTML.']);
  }
});

test('the streamed renderer lays every state out on one page', async () => {
  const reactions = [];
  const { figma } = fakeFigma(reactions);
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/bridge-code.js'), 'utf8'), {
    figma, __html__: '', setTimeout, Map, Set, Promise, Array, Math, JSON, Error, String
  });

  const graph = graphFixture();
  figma.ui.onmessage({ type: 'import-start', spec: { title: 'T' }, pageName: 'Employees' });
  for (const state of graph.states) figma.ui.onmessage({ type: 'import-state', state });
  figma.ui.onmessage({ type: 'import-finish', graph });
  await new Promise(resolve => setTimeout(resolve, 50));

  const [page] = figma.root.children;
  assert.equal(figma.root.children.length, 1);
  assert.equal(page.name, 'Employees');
  const frames = page.children.filter(child => /^State \//.test(child.name || ''));
  assert.equal(frames.length, 2);
  assert.ok(frames[1].x >= frames[0].x + 100);
  assert.equal(reactions.length, 1);
  assert.ok(reactions[0].value[0].actions[0].destinationId);
});

test('links a transition as soon as both of its states exist', async () => {
  const reactions = [];
  const { figma } = fakeFigma(reactions);
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/bridge-code.js'), 'utf8'), {
    figma, __html__: '', setTimeout, Map, Set, Promise, Array, Math, JSON, Error, String
  });

  const graph = graphFixture();
  figma.ui.onmessage({ type: 'import-start', spec: { title: 'T' }, pageName: 'Employees' });
  figma.ui.onmessage({ type: 'import-state', state: graph.states[0], transitions: graph.transitions });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reactions.length, 0, 'the destination state does not exist yet');

  figma.ui.onmessage({ type: 'import-state', state: graph.states[1], transitions: graph.transitions });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reactions.length, 1, 'both ends exist, so the link lands before import-finish');

  figma.ui.onmessage({ type: 'import-finish', graph });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reactions.length, 1, 'the final pass must not re-apply what it already linked');
});

// One endless row of frames is unreadable. States wrap into rows, and a new exploration depth always
// starts its own row, so the page reads as sections instead of a strip.
test('lays states out in rows, with a new row per exploration depth', async () => {
  const reactions = [];
  const { figma } = fakeFigma(reactions);
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/bridge-code.js'), 'utf8'), {
    figma, __html__: '', setTimeout, Map, Set, Promise, Array, Math, JSON, Error, String
  });
  const state = (id, actionPath) => ({
    id, label: id, actionPath,
    scene: { version: 1, viewport: { width: 100, height: 100 }, nodes: [] }
  });
  const paths = [[], ['a'], ['b'], ['c'], ['d'], ['e'], ['a', 'x']];

  figma.ui.onmessage({ type: 'import-start', spec: { title: 'T' }, pageName: 'Grid' });
  paths.forEach((actionPath, index) => figma.ui.onmessage({ type: 'import-state', state: state('state-0' + index, actionPath) }));
  await new Promise(resolve => setTimeout(resolve, 80));

  const frames = figma.root.children[0].children.filter(child => /^State \//.test(child.name || ''));
  assert.equal(frames.length, paths.length);
  const [root, ...rest] = frames;
  assert.equal(rest[0].y > root.y, true, 'depth 1 must start a new row below the baseline');
  const depthOne = rest.slice(0, 5);
  assert.equal(new Set(depthOne.slice(0, 4).map(frame => frame.y)).size, 1, 'the first four of a depth share a row');
  assert.equal(new Set(depthOne.slice(0, 4).map(frame => frame.x)).size, 4, 'and sit side by side');
  assert.ok(depthOne[4].y > depthOne[0].y, 'the fifth wraps onto the next row');
  assert.equal(depthOne[4].x, depthOne[0].x, 'a wrapped row restarts at the left edge');
  assert.ok(rest[5].y > depthOne[4].y, 'depth 2 starts its own row again');
});

test('waits for an in-flight render before starting a replacement session', async () => {
  let releaseFirstPage;
  const currentPages = [];
  const node = () => ({ id: String(currentPages.length + 1), appendChild() {}, resize() {} });
  const figma = {
    root: { children: [] },
    createPage() {
      const page = node();
      this.root.children.push(page);
      return page;
    },
    createFrame: node,
    createText: node,
    createNodeFromSvg: node,
    setCurrentPageAsync() {
      currentPages.push(true);
      return currentPages.length === 1 ? new Promise(resolve => { releaseFirstPage = resolve; }) : Promise.resolve();
    },
    showUI() {},
    notify() {},
    ui: { postMessage() {}, onmessage: null }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/bridge-code.js'), 'utf8'), { figma, __html__: '', setTimeout, Map, Promise, Set });
  const state = id => ({ id, label: id, actionPath: [], scene: { version: 1, viewport: { width: 1, height: 1 }, nodes: [] } });

  figma.ui.onmessage({ type: 'import-start', spec: { title: 'First' } });
  figma.ui.onmessage({ type: 'import-state', state: state('state-00') });
  await new Promise(setImmediate);
  figma.ui.onmessage({ type: 'import-start', spec: { title: 'Second' } });
  figma.ui.onmessage({ type: 'import-state', state: state('state-01') });
  await new Promise(setImmediate);

  assert.equal(currentPages.length, 1);
  releaseFirstPage();
  await new Promise(setImmediate);
  assert.equal(currentPages.length, 2);
});
