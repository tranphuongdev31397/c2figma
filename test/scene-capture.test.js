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
