const test = require('node:test');
const assert = require('node:assert/strict');
const { createZip } = require('../src/zip');

test('creates a downloadable zip containing named text files', () => {
  const files = [
    { name: 'manifest.json', content: '{"main":"code.js"}' },
    { name: 'code.js', content: 'figma.closePlugin();' }
  ];
  const zip = createZip(files);

  assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304');
  assert.ok(zip.includes(Buffer.from('manifest.json')));
  assert.ok(zip.includes(Buffer.from('code.js')));
  assert.equal(zip.subarray(-22, -18).toString('hex'), '504b0506');
  assert.deepEqual(createZip(files), zip);
});
