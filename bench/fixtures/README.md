# Bench fixtures

Each subdirectory is one screen used to score the image→Figma vision
pipeline against DOM-derived ground truth.

## Adding a fixture

1. Open `web/index.html`, drop the same HTML file this fixture is for, pick
   the static (non-interactive) capture mode, download the ZIP.
2. Unzip it, copy `scene.json` to `bench/fixtures/<case-name>/truth.json`.
3. Screenshot the same page at **exactly** `truth.json`'s `viewport` width
   and height — a mismatch makes `bench/compare.js` refuse to score it.
   Save as `bench/fixtures/<case-name>/shot.png`.
4. Generate and score:
   ```
   npm run image -- bench/fixtures/<case-name>/shot.png \
     --out bench/fixtures/<case-name>/scene.ollama.json --provider ollama
   npm run bench -- bench/fixtures/<case-name> --scene scene.ollama.json
   ```

`shot.png` and `truth.json` are committed (fixed inputs). Generated
`scene.*.json` files are gitignored — they're reproducible and change every
time the prompt is tuned; see `.claude/skills/vision-scene-prompt/references/eval-log.md`
for the record of what was tried.
