const test = require('node:test');
const assert = require('node:assert/strict');
const { generate } = require('../src/providers/ollama');

function makeFetchMock(nodes) {
  const calls = [];
  const fetchMock = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ message: { content: JSON.stringify({ nodes }) } })
    });
  };
  fetchMock.calls = calls;
  return fetchMock;
}

test('generate posts to /api/chat with the schema, prompt, and low temperature', async () => {
  const fetchMock = makeFetchMock([{ id: 'n0', kind: 'box' }]);
  const nodes = await generate('base64img', {
    width: 390, height: 844, fetch: fetchMock
  });

  assert.equal(fetchMock.calls.length, 1);
  const call = fetchMock.calls[0];
  assert.equal(call.url, 'http://localhost:11434/api/chat');
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, 'qwen2.5vl:7b');
  assert.equal(body.stream, false);
  assert.equal(body.options.temperature, 0.1);
  assert.match(body.messages[0].content, /390x844px/);
  assert.deepEqual(body.messages[0].images, ['base64img']);
  assert.equal(body.format.required[0], 'nodes');
  assert.deepEqual(nodes, [{ id: 'n0', kind: 'box' }]);
});

test('generate honors an overridden model and ollamaUrl', async () => {
  const fetchMock = makeFetchMock([]);
  await generate('img', {
    width: 100, height: 100, model: 'llama3.2-vision:11b',
    ollamaUrl: 'http://192.168.1.50:11434', fetch: fetchMock
  });
  const body = JSON.parse(fetchMock.calls[0].init.body);
  assert.equal(body.model, 'llama3.2-vision:11b');
  assert.equal(fetchMock.calls[0].url, 'http://192.168.1.50:11434/api/chat');
});

test('generate throws a clear error on a non-ok response', async () => {
  const fetchMock = () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') });
  await assert.rejects(
    generate('img', { width: 100, height: 100, fetch: fetchMock }),
    /Ollama request failed: 500 boom/
  );
});
