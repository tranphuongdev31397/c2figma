const { NODE_SCHEMA } = require('../scene-schema');
const { buildPrompt } = require('../scene-prompt');

async function generate(imageBase64, opts) {
  const {
    width,
    height,
    model = 'qwen2.5vl:7b',
    ollamaUrl = 'http://localhost:11434',
    fetch: fetchImpl = fetch
  } = opts;

  const response = await fetchImpl(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildPrompt(width, height), images: [imageBase64] }],
      format: NODE_SCHEMA,
      options: { temperature: 0.1 },
      stream: false
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const parsed = JSON.parse(payload.message.content);
  return parsed.nodes;
}

module.exports = { generate };
