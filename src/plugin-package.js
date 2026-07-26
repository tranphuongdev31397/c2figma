const fs = require('node:fs');
const path = require('node:path');
const { createPluginBundle } = require('./plugin-bundle');
const { createZip } = require('./zip');

const output = path.resolve(process.argv[2] || path.join('web', 'downloads'));
const bundle = createPluginBundle();
const files = [
  { name: 'manifest.json', content: JSON.stringify(bundle.manifest, null, 2) + '\n' },
  { name: 'code.js', content: bundle.code },
  { name: 'ui.html', content: bundle.ui },
  {
    name: 'README.md',
    content: '# HTML → Figma Direct Import\n\nImport manifest.json in Figma Desktop via Plugins → Development → Import plugin from manifest…\n'
  }
];

fs.mkdirSync(output, { recursive: true });
const target = path.join(output, 'html-figma-importer.zip');
fs.writeFileSync(target, createZip(files));
console.log(`Created ${target}`);
