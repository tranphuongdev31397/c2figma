const { NODE_SCHEMA } = require('../scene-schema');
const { buildPrompt } = require('../scene-prompt');

// Node's fetch has a ~5-minute default headers timeout. A stream:false Ollama call
// withholds the entire response until generation finishes, so a dense screen on a
// slow local model can get its connection killed before a single byte arrives.
// Streaming avoids this — headers return the instant the connection opens.
async function* readNdjsonLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

async function generate(imageBase64, opts) {
  const {
    width,
    height,
    model = 'qwen2.5vl:7b',
    ollamaUrl = 'http://localhost:11434',
    // A dense UI (dashboard, table-heavy screen) can need well over 1000 output
    // tokens of JSON; Ollama's own defaults truncate mid-response (done_reason
    // "length") long before that on qwen2.5vl:7b. Raise both, override via opts
    // for screens that need more.
    numCtx = 16384,
    numPredict = 8192,
    fetch: fetchImpl = fetch
  } = opts;

  const response = await fetchImpl(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildPrompt(width, height), images: [imageBase64] }],
      format: NODE_SCHEMA,
      options: { temperature: 0.1, num_ctx: numCtx, num_predict: numPredict },
      stream: true
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
  }

  let content = '';
  let doneReason = null;
  for await (const line of readNdjsonLines(response.body)) {
    const chunk = JSON.parse(line);
    content += chunk.message?.content ?? '';
    if (chunk.done) doneReason = chunk.done_reason;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const hint = doneReason === 'length'
      ? ' — response was cut off (hit numCtx/numPredict); raise those opts for dense screens.'
      : '';
    throw new Error(`Ollama returned invalid JSON${hint}: ${error.message}`);
  }
  return parsed.nodes;
}

module.exports = { generate };
