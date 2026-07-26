const fs = require('node:fs');
const path = require('node:path');
const { extractHtmlSpec } = require('./extract-html');
const { manifest, pluginCode } = require('./template');

function argument(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const input = process.argv[2];
if (!input || input.startsWith('-')) {
  console.error('Usage: npm run import -- path/to/design.html --out dist/design');
  process.exit(1);
}

const output = path.resolve(argument('--out', path.join('dist', path.basename(input, path.extname(input)))));
const spec = extractHtmlSpec(fs.readFileSync(path.resolve(input), 'utf8'));
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'spec.json'), JSON.stringify(spec, null, 2));
fs.writeFileSync(path.join(output, 'manifest.json'), manifest());
fs.writeFileSync(path.join(output, 'code.js'), pluginCode(spec));
fs.writeFileSync(path.join(output, 'README.md'), `# ${spec.title}\n\nGenerated metadata from the supplied HTML. For visual capture after the HTML has rendered, use the web Direct Import plugin.\n`);
console.log(`Created ${output}`);
