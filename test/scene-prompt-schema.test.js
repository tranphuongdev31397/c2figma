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
  assert.match(prompt, /parent before any of its children/);
});
