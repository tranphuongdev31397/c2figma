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

const fakeFigma = reactions => {
  let ids = 0;
  const node = () => ({
    id: 'node-' + (ids += 1),
    appendChild() {},
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
      ui: { postMessage() { throw new Error('no visible UI'); }, onmessage: null }
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
    const { figma, closed } = fakeFigma(reactions);
    vm.runInNewContext(generate(), { figma, __html__: '', setTimeout, Map, Set, Promise, Array, Math, JSON, Error, String });
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(figma.root.children.length, 2);
    assert.deepEqual(figma.root.children.map(page => page.name), ['Employees · Default', 'Employees · Opened']);
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].value[0].trigger.type, 'ON_CLICK');
    assert.equal(reactions[0].value[0].actions[0].transition.type, 'DISSOLVE');
    assert.ok(reactions[0].value[0].actions[0].destinationId);
    assert.deepEqual(closed, ['Đã tạo design editable từ HTML.']);
  }
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
