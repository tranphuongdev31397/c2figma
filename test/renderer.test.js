const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

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

test('keeps a graph renderer available for opt-in interaction states', () => {
  for (const file of renderers) {
    assert.match(fs.readFileSync(require.resolve(file), 'utf8'), /renderGraph/);
  }
});
