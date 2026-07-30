const fs = require('node:fs');
const path = require('node:path');
const { readPngSize, assertImageSize } = require('./png-size');
const ollama = require('./providers/ollama');
const openai = require('./providers/openai');

const PROVIDERS = { ollama, openai };

// ponytail: the vision model outputs hex (natural for a vision model);
// the wire-format renderer wants {r,g,b,a} 0..1. Convert once here, at
// the CLI's post-processing boundary, instead of teaching the model or
// the renderer a second color format.
function hexToWire(hex) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || '');
  if (!match) return null;
  const full = match[1].length === 3 ? match[1].split('').map(c => c + c).join('') : match[1];
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
    a: 1
  };
}

function fillNodeDefaults(node) {
  return {
    ...node,
    fill: hexToWire(node.fill),
    stroke: hexToWire(node.stroke),
    color: hexToWire(node.color),
    opacity: 1,
    position: 'static',
    zIndex: 'auto',
    overflow: 'visible',
    lines: 1,
    svg: null,
    borders: null
  };
}

function buildScene(nodes, viewport) {
  return { version: 1, viewport, nodes: nodes.map(fillNodeDefaults) };
}

function argument(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const input = process.argv[2];
  if (!input || input.startsWith('-')) {
    console.error(
      'Usage: npm run image -- path/to/shot.png --out scene.json ' +
      '[--provider ollama|openai] [--model NAME] [--ollama-url URL] [--api-key KEY]'
    );
    process.exit(1);
  }

  const providerName = argument('--provider', 'ollama');
  const provider = PROVIDERS[providerName];
  if (!provider) {
    console.error(`Unknown provider "${providerName}" — expected one of: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(path.resolve(input));
  const { width, height } = readPngSize(buffer);
  assertImageSize({ width, height });

  const nodes = await provider.generate(buffer.toString('base64'), {
    width,
    height,
    model: argument('--model', undefined),
    ollamaUrl: argument('--ollama-url', undefined),
    apiKey: argument('--api-key', undefined)
  });

  if (!Array.isArray(nodes)) {
    throw new Error(`Provider "${providerName}" returned no nodes array — response was: ${JSON.stringify(nodes)}`);
  }

  const scene = buildScene(nodes, { width, height });
  const output = path.resolve(argument('--out', 'scene.json'));
  fs.writeFileSync(output, JSON.stringify(scene, null, 2));
  console.log(`Wrote ${output} (${nodes.length} nodes, provider=${providerName})`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { fillNodeDefaults, buildScene, hexToWire };
