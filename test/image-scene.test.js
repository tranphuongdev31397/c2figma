const test = require('node:test');
const assert = require('node:assert/strict');
const { fillNodeDefaults, buildScene, hexToWire } = require('../src/image-scene');

test('hexToWire converts a 6-digit hex to {r,g,b,a:1} scaled 0..1', () => {
  assert.deepEqual(hexToWire('#FF0000'), { r: 1, g: 0, b: 0, a: 1 });
});

test('hexToWire expands a 3-digit hex to the same result as its 6-digit form', () => {
  assert.deepEqual(hexToWire('#F00'), hexToWire('#FF0000'));
});

test('hexToWire returns null for null input and for a non-hex string', () => {
  assert.equal(hexToWire(null), null);
  assert.equal(hexToWire('not-a-color'), null);
});

test('fillNodeDefaults adds the wire-format fields a vision model cannot infer', () => {
  const raw = {
    id: 'n0', parentId: null, kind: 'box', name: 'Card / Product',
    x: 10, y: 20, width: 100, height: 50, fill: '#FF0000', stroke: null,
    strokeWidth: 0, radius: 4, text: '', fontSize: 0, fontWeight: 400, color: null
  };
  const filled = fillNodeDefaults(raw);
  assert.deepEqual(filled.fill, { r: 1, g: 0, b: 0, a: 1 });
  assert.equal(filled.stroke, null);
  assert.equal(filled.color, null);
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
