const fs = require('node:fs');
const path = require('node:path');

const MATCH_THRESHOLD = 0.3;

function hexToRgb(hex) {
  if (!hex) return null;
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const value = parseInt(full, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

// ponytail: Euclidean RGB distance, not CIEDE2000 — good enough to tell "close"
// from "wrong" for a first pass. Upgrade to CIEDE2000 (already available in
// .claude/finan-qc/ui-engine/'s venv, a different project, not installed here)
// if this proves misleading against eval-log.md results.
function colorDelta(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return null;
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function iou(a, b) {
  const ax2 = a.x + a.width, ay2 = a.y + a.height;
  const bx2 = b.x + b.width, by2 = b.y + b.height;
  const ix1 = Math.max(a.x, b.x), iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const interW = Math.max(0, ix2 - ix1), interH = Math.max(0, iy2 - iy1);
  const inter = interW * interH;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

function matchNodes(truthNodes, sceneNodes) {
  const candidates = [];
  for (const t of truthNodes) {
    for (const s of sceneNodes) {
      if (t.kind !== s.kind) continue;
      const overlap = iou(t, s);
      if (overlap > MATCH_THRESHOLD) candidates.push({ t, s, score: overlap });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const usedTruth = new Set();
  const usedScene = new Set();
  const matches = [];
  for (const candidate of candidates) {
    if (usedTruth.has(candidate.t) || usedScene.has(candidate.s)) continue;
    usedTruth.add(candidate.t);
    usedScene.add(candidate.s);
    matches.push(candidate);
  }
  return matches;
}

// ponytail: exact-string match after whitespace normalization, no fuzzy/Levenshtein
// distance. Upgrade if OCR-style near-misses (1-2 character drift) dominate the
// error signal in eval-log.md — see .claude/skills/vision-scene-prompt/references/eval-log.md.
function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function score(truth, scene) {
  if (truth.viewport.width !== scene.viewport.width || truth.viewport.height !== scene.viewport.height) {
    throw new Error(
      `Viewport mismatch: truth is ${truth.viewport.width}x${truth.viewport.height}, ` +
      `scene is ${scene.viewport.width}x${scene.viewport.height} — capture the screenshot at the ` +
      'truth viewport before comparing.'
    );
  }

  const matches = matchNodes(truth.nodes, scene.nodes);
  const meanIou = matches.length
    ? matches.reduce((sum, m) => sum + m.score, 0) / matches.length
    : 0;

  const colorDeltas = matches
    .map(m => colorDelta(m.t.fill ?? m.t.color, m.s.fill ?? m.s.color))
    .filter(d => d !== null);
  const meanColorDelta = colorDeltas.length
    ? colorDeltas.reduce((sum, d) => sum + d, 0) / colorDeltas.length
    : null;

  const textPairs = matches.filter(m => m.t.kind === 'text');
  const textMatches = textPairs.filter(m => normalizeText(m.t.text) === normalizeText(m.s.text));
  const textMatchRate = textPairs.length ? textMatches.length / textPairs.length : null;

  return {
    matchedCount: matches.length,
    truthCount: truth.nodes.length,
    sceneCount: scene.nodes.length,
    precision: scene.nodes.length ? matches.length / scene.nodes.length : 0,
    recall: truth.nodes.length ? matches.length / truth.nodes.length : 0,
    meanIou,
    meanColorDelta,
    textMatchRate
  };
}

function argument(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function main() {
  const fixtureDir = process.argv[2];
  if (!fixtureDir || fixtureDir.startsWith('-')) {
    console.error('Usage: node bench/compare.js path/to/fixture-dir --scene scene.provider.json');
    process.exit(1);
  }

  const sceneFile = argument('--scene', 'scene.json');
  const truth = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'truth.json'), 'utf8'));
  const scene = JSON.parse(fs.readFileSync(path.join(fixtureDir, sceneFile), 'utf8'));

  const result = score(truth, scene);
  const colorText = result.meanColorDelta === null ? 'n/a' : result.meanColorDelta.toFixed(1);
  const textMatchText = result.textMatchRate === null ? 'n/a' : `${Math.round(result.textMatchRate * 100)}%`;

  console.log(`Fixtures: 1 screen (${fixtureDir})`);
  console.log(`Score: IoU ${result.meanIou.toFixed(2)}, color ΔE ${colorText}, text-match ${textMatchText}`);
  console.log(
    `Precision ${result.precision.toFixed(2)} (${result.matchedCount}/${result.sceneCount} scene nodes matched) · ` +
    `Recall ${result.recall.toFixed(2)} (${result.matchedCount}/${result.truthCount} truth nodes matched)`
  );
}

if (require.main === module) {
  main();
}

module.exports = { iou, colorDelta, matchNodes, normalizeText, score };
