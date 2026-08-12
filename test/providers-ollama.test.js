const test = require('node:test');
const assert = require('node:assert/strict');
const { generate } = require('../src/providers/ollama');

// Ollama's stream:false mode withholds the HTTP response entirely until generation
// finishes. Node's fetch has a ~5-minute default headers timeout, and a dense screen
// on a slow local model can take longer than that to generate — the connection gets
// killed before a single byte arrives. Streaming NDJSON lines back avoids this: headers
// return the moment the connection opens, well under any timeout.
function makeStreamMock(deltas, { doneReason = 'stop' } = {}) {
  const calls = [];
  const fetchMock = (url, init) => {
    calls.push({ url, init });
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const delta of deltas) {
          controller.enqueue(encoder.encode(JSON.stringify({ message: { content: delta }, done: false }) + '\n'));
        }
        controller.enqueue(encoder.encode(JSON.stringify({ done: true, done_reason: doneReason }) + '\n'));
        controller.close();
      }
    });
    return Promise.resolve({ ok: true, body, text: () => Promise.resolve('') });
  };
  fetchMock.calls = calls;
  return fetchMock;
}

test('generate posts to /api/chat with the schema, prompt, low temperature, and streams the response', async () => {
  const fetchMock = makeStreamMock([JSON.stringify({ nodes: [{ id: 'n0', kind: 'box' }] })]);
  const nodes = await generate('base64img', {
    width: 390, height: 844, fetch: fetchMock
  });

  assert.equal(fetchMock.calls.length, 1);
  const call = fetchMock.calls[0];
  assert.equal(call.url, 'http://localhost:11434/api/chat');
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, 'qwen2.5vl:7b');
  assert.equal(body.stream, true);
  assert.equal(body.options.temperature, 0.1);
  assert.equal(body.options.num_ctx, 16384);
  assert.equal(body.options.num_predict, 8192);
  assert.match(body.messages[0].content, /390x844px/);
  assert.deepEqual(body.messages[0].images, ['base64img']);
  assert.equal(body.format.required[0], 'nodes');
  assert.deepEqual(nodes, [{ id: 'n0', kind: 'box' }]);
});

test('generate reassembles content split across multiple stream chunks', async () => {
  const json = JSON.stringify({ nodes: [{ id: 'n0', kind: 'text' }, { id: 'n1', kind: 'box' }] });
  const mid = Math.floor(json.length / 2);
  const fetchMock = makeStreamMock([json.slice(0, mid), json.slice(mid)]);
  const nodes = await generate('img', { width: 100, height: 100, fetch: fetchMock });
  assert.deepEqual(nodes, [{ id: 'n0', kind: 'text' }, { id: 'n1', kind: 'box' }]);
});

test('generate honors an overridden model and ollamaUrl', async () => {
  const fetchMock = makeStreamMock([JSON.stringify({ nodes: [] })]);
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

test('generate honors overridden numCtx/numPredict', async () => {
  const fetchMock = makeStreamMock([JSON.stringify({ nodes: [] })]);
  await generate('img', { width: 100, height: 100, numCtx: 32768, numPredict: 4096, fetch: fetchMock });
  const body = JSON.parse(fetchMock.calls[0].init.body);
  assert.equal(body.options.num_ctx, 32768);
  assert.equal(body.options.num_predict, 4096);
});

test('generate names truncation as the cause when a cut-off stream is not valid JSON', async () => {
  const fetchMock = makeStreamMock(['{"nodes": [{"id": "n0"'], { doneReason: 'length' });
  await assert.rejects(
    generate('img', { width: 100, height: 100, fetch: fetchMock }),
    /cut off.*numCtx\/numPredict/
  );
});
