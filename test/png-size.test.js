const test = require('node:test');
const assert = require('node:assert/strict');
const { readPngSize, assertImageSize, MAX_LONG_EDGE } = require('../src/png-size');

function fakePng(width, height) {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test('readPngSize reads width/height from the IHDR chunk', () => {
  const size = readPngSize(fakePng(390, 844));
  assert.deepEqual(size, { width: 390, height: 844 });
});

test('readPngSize rejects a buffer with the wrong signature', () => {
  const notPng = Buffer.alloc(24, 0);
  assert.throws(() => readPngSize(notPng), /Not a valid PNG/);
});

test('readPngSize rejects a too-short buffer', () => {
  assert.throws(() => readPngSize(Buffer.alloc(4)), /Not a valid PNG/);
});

test('assertImageSize passes at exactly the long-edge limit', () => {
  assert.doesNotThrow(() => assertImageSize({ width: MAX_LONG_EDGE, height: 100 }));
});

test('assertImageSize throws when the long edge exceeds the limit', () => {
  assert.throws(
    () => assertImageSize({ width: MAX_LONG_EDGE + 1, height: 100 }),
    /exceeds 2576px/
  );
});

test('assertImageSize checks height as the long edge too', () => {
  assert.throws(
    () => assertImageSize({ width: 100, height: MAX_LONG_EDGE + 1 }),
    /exceeds 2576px/
  );
});
