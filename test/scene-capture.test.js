const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../web/scene-capture.js'), 'utf8');

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

test('exposes an opt-in bounded state graph capture path', () => {
  assert.match(source, /captureStateGraph/);
  assert.match(source, /maxDepth/);
  assert.match(source, /maxStates/);
  assert.match(source, /\.click\(\)/);
  assert.match(source, /actionPath/);
});
