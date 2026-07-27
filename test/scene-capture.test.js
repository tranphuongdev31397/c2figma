const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../web/scene-capture.js'), 'utf8');

const load = () => {
  const scope = { window: {}, document: { createElement: () => ({}) } };
  scope.window.document = scope.document;
  vm.runInNewContext(source, scope);
  return scope.window;
};

test('gives a bundled page the same settle budget on both capture paths', () => {
  const { settleProfileFor } = load();
  const bundled = settleProfileFor('<div data-src="/__bundler/manifest.json"></div>');
  const plain = settleProfileFor('<p>hello</p>');

  assert.equal(bundled.bundled, true);
  assert.equal(plain.bundled, false);
  assert.ok(bundled.minimumDelay > plain.minimumDelay, 'a bundled page needs longer to hydrate');
  assert.ok(bundled.timeoutMs > bundled.minimumDelay, 'the capture must not time out before the page can settle');
  assert.ok(plain.timeoutMs > plain.minimumDelay);
});

test('waits for running animations to finish before capturing a state', () => {
  // ponytail: a fixed sleep captures a modal mid-fade, which both blurs the layer and
  // makes every replay of the same action fingerprint differently.
  assert.match(source, /getAnimations/);
  assert.match(source, /playState/);
  assert.doesNotMatch(source, /click\(\);\s*await sleep\(settleMs\);\s*\}/);
});

test('fingerprints a state by its structure, not by its animation frame', () => {
  const { sceneFingerprintFor } = load();
  const node = opacity => ({
    kind: 'frame', name: 'Modal', x: 10.4, y: 20.6, width: 100.2, height: 50,
    text: 'Thêm nhân viên mới', fill: { r: 1, g: 1, b: 1, a: 1 }, opacity
  });

  assert.equal(
    sceneFingerprintFor({ nodes: [node(0.4)] }),
    sceneFingerprintFor({ nodes: [node(1)] }),
    'the same modal caught mid-fade and fully open is one state'
  );
  assert.notEqual(
    sceneFingerprintFor({ nodes: [node(1)] }),
    sceneFingerprintFor({ nodes: [{ ...node(1), text: 'Sửa nhân viên' }] }),
    'different content is still a different state'
  );
});

// A dialog fades in over ~200ms, and for the first frames its own opacity is exactly 0 while every
// child keeps opacity 1. Dropping just the faded element left its children behind, reparented onto the
// backdrop: the dialog's white sheet vanished and the page showed through its body.
const fakeDocument = (elements, animations = []) => {
  const styles = new Map();
  const rects = new Map();
  for (const element of elements) {
    element.childNodes = [];
    element.getAttribute = name => element.attributes?.[name] ?? null;
    element.closest = () => null;
    element.id = element.attributes?.id || '';
    styles.set(element, {
      display: 'block', visibility: 'visible',
      // read late: an animation that lands changes it between getAnimations() and the style read
      get opacity() { return String(element.opacity ?? 1); },
      position: element.position || 'static', zIndex: 'auto', overflow: 'visible',
      backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)', fontSize: '14px', fontWeight: '400',
      borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      borderTopColor: 'rgb(0, 0, 0)', borderRightColor: 'rgb(0, 0, 0)', borderBottomColor: 'rgb(0, 0, 0)', borderLeftColor: 'rgb(0, 0, 0)',
      borderTopLeftRadius: '0px', borderTopRightRadius: '0px', borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px'
    });
    rects.set(element, { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 });
    element.getBoundingClientRect = () => rects.get(element);
  }
  return {
    querySelectorAll: () => elements,
    getAnimations: () => animations,
    getComputedStyle: element => styles.get(element)
  };
};

const runSerialize = (elements, animations) => {
  const body = source.match(/\n {2}function serializeScene\([\s\S]*?\n {2}\}\n/)[0];
  const dom = fakeDocument(elements, animations);
  const scope = {
    document: dom,
    getComputedStyle: dom.getComputedStyle,
    Set, Map, Math, Number, JSON, Error, String, Array
  };
  vm.runInNewContext(body + '\nresult = serializeScene("", 1440, 900);', scope);
  return scope.result;
};

test('drops the whole subtree of a layer faded to nothing, not just that layer', () => {
  const overlay = { tagName: 'DIV', attributes: { class: 'role-modal-overlay' }, parentElement: null, position: 'fixed' };
  const sheet = { tagName: 'DIV', attributes: { class: 'role-modal' }, parentElement: overlay, opacity: 0 };
  const head = { tagName: 'DIV', attributes: { class: 'rm-head' }, parentElement: sheet };
  const title = { tagName: 'SPAN', attributes: {}, parentElement: head };

  const names = runSerialize([overlay, sheet, head, title]).nodes.map(node => node.name);

  assert.ok(names.some(name => /role-modal-overlay/.test(name)), 'the backdrop is fully opaque and stays');
  assert.ok(!names.some(name => /rm-head/.test(name)), 'a child of a fully faded layer is invisible too');
  assert.ok(!names.some(name => /role-modal ·/.test(name)), 'the faded layer itself is still dropped');
  assert.equal(names.length, 1);
});

test('re-checks for animations that only start after the first look', () => {
  // the dialog remounts on a later tick, so one getAnimations() call can find a calm page and
  // serialize straight into the next fade.
  assert.match(source, /calm/);
  assert.doesNotMatch(source, /await sleep\(settleMs\);\s*await waitForAnimations\(\);\s*await sleep\(settleMs\);\s*\}/);
});

test('ends every running animation before reading the page', () => {
  // Out-waiting a fade is a race the capture keeps losing. These are Web Animations, so no injected
  // stylesheet reaches them — the probe has to end them itself.
  const overlay = { tagName: 'DIV', attributes: { class: 'role-modal-overlay' }, parentElement: null, position: 'fixed' };
  const sheet = { tagName: 'DIV', attributes: { class: 'role-modal' }, parentElement: overlay, opacity: 0 };
  const finished = [];
  const animations = [
    { name: 'fade', finish() { finished.push('fade'); sheet.opacity = 1; } },
    { name: 'spinner', finish() { finished.push('spinner'); throw new Error('Cannot finish Animation with an infinite target effect'); } }
  ];

  const names = runSerialize([overlay, sheet], animations).nodes.map(node => node.name);

  assert.deepEqual(finished, ['fade', 'spinner'], 'every animation is asked to land');
  assert.ok(names.some(name => /role-modal ·/.test(name)), 'the dialog that finished its fade is captured whole');
});

test('caps how long one action may wait to settle', () => {
  // an unbounded re-check spent 12s per action and blew the per-path budget, so every path that
  // opened something animated timed out and its state never existed.
  const { settleProfileFor } = load();
  const budget = source.match(/const SETTLE_BUDGET_MS = (\d+)/);

  assert.ok(budget, 'the settle needs a stated ceiling');
  const perAction = Number(budget[1]);
  assert.ok(perAction <= 2000, 'a single action must not eat seconds');
  // two actions deep plus hydration still has to fit inside the path timeout
  const profile = settleProfileFor('<div data-src="/__bundler/manifest.json"></div>');
  assert.ok(profile.minimumDelay + perAction * 2 < profile.timeoutMs, 'settling must fit the path budget');
  assert.match(source, /SETTLE_BUDGET_MS/);
});

test('bounds exploration by depth rather than by a state count', () => {
  const { explorationLimits } = load();

  // a state cap discards states the run already paid for without shortening the run
  assert.equal(explorationLimits.maxStates, undefined);
  assert.ok(explorationLimits.maxDepth >= 2);
  assert.ok(explorationLimits.maxActionsPerState > 0);
});

test('offers a reused-iframe mode without making it the default', () => {
  const { captureModes, defaultCaptureMode } = load();

  assert.deepEqual(Object.keys(captureModes).sort(), ['fresh', 'reuse']);
  assert.equal(defaultCaptureMode, 'fresh', 'a fresh iframe per path stays the trusted baseline');
  // reuse trades isolation for speed, so it has to prove it got back to the baseline
  assert.match(source, /resetToBaseline/);
  assert.match(source, /html-figma-ready/);
  assert.match(source, /reuse-degraded/);
});

test('finds a dialog to dismiss by shape, not by the class it may not have', () => {
  // the sheet in the real page is inline-styled divs: no class, no aria-label, and Escape does nothing.
  // Only a viewport-sized positioned layer identifies the backdrop that closes it.
  assert.match(source, /dismissers/);
  assert.match(source, /innerWidth \* 0\.9/);
  assert.match(source, /position === 'fixed' \|\| position === 'absolute'/);
  assert.match(source, /document\.activeElement \|\| document\.body/);
});

test('reloads the reused iframe instead of capturing a leftover modal', () => {
  // a path replayed on top of the previous path's modal is not that path, so its state is worthless
  assert.match(source, /const boot = /);
  assert.match(source, /await boot\(\);\s*\n\s*return send\(actionPath\)/);
});

test('captures z-index so the renderer can rebuild stacking order', () => {
  assert.match(source, /zIndex: style\.zIndex/);
});

test('both probes serialize into valid injectable scripts', () => {
  // the probes reach the iframe as source text, so a syntax slip only shows up at run time
  const scope = { window: {}, document: { createElement: () => ({ setAttribute() {}, style: {} }) } };
  scope.window.document = scope.document;
  vm.runInNewContext(source, scope);

  const injected = [...new Set([...source.matchAll(/\+ (\w+)\.toString\(\)/g)].map(match => match[1]))];
  assert.deepEqual(injected.sort(), [
    'actionKeyFor', 'captureInteractivePath', 'captureWhenStable',
    'interactionToolkit', 'reusableProbe', 'sceneFingerprint', 'serializeScene'
  ]);

  for (const probe of injected) {
    const body = source.match(new RegExp('\\n  function ' + probe + '\\([\\s\\S]*?\\n  \\}\\n'));
    assert.ok(body, probe + ' must be a top-level function so toString() carries it whole');
    assert.doesNotThrow(() => new vm.Script('(function(){' + body[0] + '})'), probe + ' is not valid JavaScript');
  }
});

test('reports attempted paths, not only discovered states', () => {
  // most paths dedupe away, so a states-only counter sits still while the run is busy
  assert.match(source, /onProgress/);
  assert.match(source, /attempted/);
  assert.match(source, /planned/);
});

test('the interactive path waits for the same profile as the static path', () => {
  assert.match(source, /settleProfileFor\(html\)/);
  assert.match(source, /minimumDelay/);
  assert.doesNotMatch(source, /stateTimeoutMs: 1500/);
});

test('waits for the rendered DOM to settle before serializing a bundled page', () => {
  assert.match(source, /captureWhenStable/);
  assert.match(source, /stableTicks/);
  assert.match(source, /__bundler.*manifest/);
  assert.match(source, /borderBottomColor/);
});

test('captures native control text and SVG artwork as real scene layers', () => {
  assert.match(source, /element\.placeholder/);
  assert.match(source, /kind: isSvg \? 'svg'/);
  assert.match(source, /outerHTML/);
});

test('recognizes SVG roots regardless of HTML tag-name casing', () => {
  assert.match(source, /element\.tagName\.toLowerCase\(\) === 'svg'/);
});

test('preserves positioned layers for renderer stacking', () => {
  assert.match(source, /position: style\.position/);
});

test('captures CSS overflow so Figma does not over-clip text', () => {
  assert.match(source, /overflow: style\.overflow/);
});

test('names element layers with stable semantic names and indexes', () => {
  assert.match(source, /nameForElement/);
  assert.match(source, /nameIndex/);
  assert.match(source, /padStart\(2, '0'\)/);
});

test('captures border widths per side instead of flattening them', () => {
  assert.match(source, /top: \{ width: number\(style\.borderTopWidth\)/);
  assert.match(source, /bottom: \{ width: number\(style\.borderBottomWidth\)/);
});

test('exposes the bounded interactive state graph contract', () => {
  assert.match(source, /captureStateGraph/);
  assert.match(source, /onState/);
  assert.match(source, /actionKey/);
  assert.match(source, /transitions/);
  assert.match(source, /data-c2figma-action-key/);
  assert.match(source, /maxActionsPerState/);
  assert.match(source, /fingerprintToState/);
});

// Discovery is what stamps data-c2figma-action-key onto the elements. Serializing before it ran left
// the scene carrying the tags of the previous state — or, on the baseline, none at all — so the
// renderer could not find the layer a transition starts from and dropped the link.
const runProbe = (name, call, scope) => {
  const body = source.match(new RegExp('\\n {2}function ' + name + '\\([\\s\\S]*?\\n {2}\\}\\n'))[0];
  vm.runInNewContext(body + '\n' + call + ';', scope);
};

const probeScope = calls => ({
  setTimeout, Promise, Error, JSON, Map, Set, Date,
  parent: { postMessage(message) { calls.push('post:' + (message.actions || []).length); } },
  window: { addEventListener() {} },
  toolkit: () => ({
    waitForStable: async () => {},
    replay: async () => {},
    settleAfterAction: async () => {},
    listActions: () => { calls.push('tag'); return [{ key: 'a1', label: 'x', trigger: 'ON_CLICK' }]; }
  }),
  actionKeyFor: () => 'a1',
  serialize: () => { calls.push('serialize'); return { nodes: [] }; },
  fingerprint: () => 'fp'
});

test('tags the state it is about to serialize, not the one before it', async () => {
  const calls = [];
  const scope = probeScope(calls);
  runProbe('captureInteractivePath', "captureInteractivePath(toolkit, actionKeyFor, serialize, 'tok', 100, 100, 0, [], 0)", scope);
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.deepEqual(calls, ['tag', 'serialize', 'post:1'],
    'discovery stamps the action keys, so it has to run before the scene is read');
});

test('replays actions by stable key instead of candidate index', () => {
  assert.match(source, /actionKeyFor/);
  assert.match(source, /find\(.*\.key.*actionPath/);
  assert.doesNotMatch(source, /candidates\[actionPath\[/);
});

test('filters decorative candidates from action discovery', () => {
  assert.match(source, /aria-hidden.*true/);
  assert.match(source, /role.*presentation.*none/);
});

test('filters external navigation schemes while allowing hash links', () => {
  assert.match(source, /https\?\|ftp\|data\|javascript\|mailto\|tel/);
  assert.match(source, /test\(element\.href\)/);
  assert.doesNotMatch(source, /href.*#.*external/);
});

test('preserves same-document hash links before resolving the URL', () => {
  assert.match(source, /const href = element\.getAttribute\('href'\) \|\| ''/);
  assert.match(source, /!href\.startsWith\('#'\)/);
});
