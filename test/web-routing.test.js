const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const rewrites = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).rewrites;

// ponytail: the deploy has no build step, so a served path either has a rewrite or is a real file at the repo root.
const matches = (source, reference) => {
  if (source === reference) return true;
  const prefix = source.match(/^(.*)\/:[^/]+\*$/);
  return Boolean(prefix) && reference.startsWith(prefix[1] + '/');
};

const resolves = reference =>
  rewrites.some(entry => matches(entry.source, reference)) || fs.existsSync(path.join(root, reference));

test('every absolute asset the web page requests is served by the deploy', () => {
  const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  const references = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map(match => match[1]);

  assert.ok(references.length, 'expected the page to reference absolute paths');
  for (const reference of references) {
    assert.ok(resolves(reference), reference + ' is requested by web/index.html but the deploy serves nothing there');
  }
});
