const test = require('node:test');
const assert = require('node:assert/strict');
const { generate } = require('../src/providers/openai');

function makeFetchMock(nodes) {
  const calls = [];
  const fetchMock = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ nodes }) } }] })
    });
  };
  fetchMock.calls = calls;
  return fetchMock;
}

test('generate posts to chat/completions with schema, image, and bearer auth', async () => {
  const fetchMock = makeFetchMock([{ id: 'n0', kind: 'text' }]);
  const nodes = await generate('base64img', {
    width: 390, height: 844, apiKey: 'sk-test', fetch: fetchMock
  });

  assert.equal(fetchMock.calls.length, 1);
  const call = fetchMock.calls[0];
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.init.headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.required[0], 'nodes');
  const content = body.messages[0].content;
  assert.match(content[0].text, /390x844px/);
  assert.equal(content[1].image_url.url, 'data:image/png;base64,base64img');
  assert.deepEqual(nodes, [{ id: 'n0', kind: 'text' }]);
});

test('generate honors an overridden model', async () => {
  const fetchMock = makeFetchMock([]);
  await generate('img', { width: 100, height: 100, model: 'gpt-4o', apiKey: 'sk-test', fetch: fetchMock });
  const body = JSON.parse(fetchMock.calls[0].init.body);
  assert.equal(body.model, 'gpt-4o');
});

test('generate throws without an API key', async () => {
  await assert.rejects(
    generate('img', { width: 100, height: 100, apiKey: '', fetch: makeFetchMock([]) }),
    /requires an API key/
  );
});

test('generate throws a clear error on a non-ok response', async () => {
  const fetchMock = () => Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('bad key') });
  await assert.rejects(
    generate('img', { width: 100, height: 100, apiKey: 'sk-test', fetch: fetchMock }),
    /OpenAI request failed: 401 bad key/
  );
});
