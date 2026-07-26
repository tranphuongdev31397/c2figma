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

test('leaves room for a second level of exploration', () => {
  const { explorationLimits } = load();

  // ponytail: one screen easily offers maxActionsPerState candidates, so a state budget equal to that
  // is spent entirely at depth 1 and the second click never happens.
  assert.ok(
    explorationLimits.maxStates > explorationLimits.maxActionsPerState,
    'depth 1 alone can fill the state budget'
  );
  assert.ok(explorationLimits.maxDepth >= 2);
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
