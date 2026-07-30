// test/bench-compare.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { iou, colorDelta, matchNodes, normalizeText, score } = require('../bench/compare');

test('iou is 1.0 for identical boxes', () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };
  assert.equal(iou(box, box), 1);
});

test('iou is 0 for non-overlapping boxes', () => {
  assert.equal(iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 100, width: 10, height: 10 }), 0);
});

test('iou is between 0 and 1 for partial overlap', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  const b = { x: 5, y: 5, width: 10, height: 10 };
  const result = iou(a, b);
  assert.ok(result > 0 && result < 1, `expected 0 < iou < 1, got ${result}`);
});

test('colorDelta is 0 for identical hex colors', () => {
  assert.equal(colorDelta('#FF5733', '#FF5733'), 0);
});

test('colorDelta is null when either color is missing', () => {
  assert.equal(colorDelta(null, '#FFFFFF'), null);
  assert.equal(colorDelta('#FFFFFF', null), null);
});

test('colorDelta measures Euclidean RGB distance', () => {
  // black vs white: sqrt(255^2 * 3) ≈ 441.67
  const delta = colorDelta('#000000', '#FFFFFF');
  assert.ok(Math.abs(delta - 441.67) < 0.1, `expected ~441.67, got ${delta}`);
});

test('normalizeText collapses whitespace and trims', () => {
  assert.equal(normalizeText('  Hello   World  '), 'Hello World');
  assert.equal(normalizeText(null), '');
});

test('matchNodes greedily assigns highest-IoU pairs of the same kind, one-to-one', () => {
  const truth = [
    { kind: 'box', x: 0, y: 0, width: 10, height: 10 },
    { kind: 'text', x: 0, y: 0, width: 10, height: 10 }
  ];
  const scene = [
    { kind: 'box', x: 0, y: 0, width: 10, height: 10 },
    { kind: 'box', x: 50, y: 50, width: 10, height: 10 }
  ];
  const matches = matchNodes(truth, scene);
  assert.equal(matches.length, 1, 'only the matching-kind, overlapping pair counts');
  assert.equal(matches[0].t, truth[0]);
  assert.equal(matches[0].s, scene[0]);
});

test('matchNodes ignores pairs below the IoU threshold', () => {
  const truth = [{ kind: 'box', x: 0, y: 0, width: 10, height: 10 }];
  const scene = [{ kind: 'box', x: 9, y: 9, width: 10, height: 10 }];
  // small overlap corner — IoU well under 0.3
  assert.equal(matchNodes(truth, scene).length, 0);
});

test('score throws on a viewport mismatch', () => {
  const truth = { viewport: { width: 390, height: 844 }, nodes: [] };
  const scene = { viewport: { width: 400, height: 844 }, nodes: [] };
  assert.throws(() => score(truth, scene), /Viewport mismatch/);
});

test('score aggregates precision, recall, mean IoU, color delta, and text match rate', () => {
  const truth = {
    viewport: { width: 100, height: 100 },
    nodes: [
      { kind: 'box', x: 0, y: 0, width: 10, height: 10, fill: '#000000', color: null, text: '' },
      { kind: 'text', x: 20, y: 20, width: 10, height: 10, fill: null, color: null, text: 'Hello' }
    ]
  };
  const scene = {
    viewport: { width: 100, height: 100 },
    nodes: [
      { kind: 'box', x: 0, y: 0, width: 10, height: 10, fill: '#000000', color: null, text: '' },
      { kind: 'text', x: 20, y: 20, width: 10, height: 10, fill: null, color: null, text: 'Hello' },
      { kind: 'box', x: 90, y: 90, width: 5, height: 5, fill: null, color: null, text: '' }
    ]
  };
  const result = score(truth, scene);
  assert.equal(result.matchedCount, 2);
  assert.equal(result.truthCount, 2);
  assert.equal(result.sceneCount, 3);
  assert.equal(result.recall, 1);
  assert.ok(Math.abs(result.precision - 2 / 3) < 1e-9);
  assert.equal(result.meanIou, 1);
  assert.equal(result.meanColorDelta, 0);
  assert.equal(result.textMatchRate, 1);
});
