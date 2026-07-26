const test = require('node:test');
const assert = require('node:assert/strict');
const { createPluginBundle } = require('../src/plugin-bundle');

test('creates a Figma plugin bundle that imports from its own UI', () => {
  const bundle = createPluginBundle();

  assert.equal(bundle.manifest.ui, 'ui.html');
  assert.equal(bundle.manifest.documentAccess, 'dynamic-page');
  assert.match(bundle.code, /figma\.showUI\(__html__/);
  assert.match(bundle.code, /figma\.setCurrentPageAsync\(page\)/);
  assert.doesNotMatch(bundle.code, /figma\.currentPage\s*=\s*page/);
  assert.match(bundle.code, /type !== 'import'/);
  assert.match(bundle.ui, /parent\.postMessage\(\{ pluginMessage:/);
});
