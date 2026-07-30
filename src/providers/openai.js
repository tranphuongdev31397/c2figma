const { NODE_SCHEMA } = require('../scene-schema');
const { buildPrompt } = require('../scene-prompt');

async function generate(imageBase64, opts) {
  const {
    width,
    height,
    model = 'gpt-4o-mini',
    apiKey = process.env.OPENAI_API_KEY,
    fetch: fetchImpl = fetch
  } = opts;

  if (!apiKey) {
    throw new Error('OpenAI provider requires an API key — set OPENAI_API_KEY or pass --api-key');
  }

  const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(width, height) },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } }
        ]
      }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'scene', strict: true, schema: NODE_SCHEMA }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const parsed = JSON.parse(payload.choices[0].message.content);
  return parsed.nodes;
}

module.exports = { generate };
