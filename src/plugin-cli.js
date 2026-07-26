const fs = require('node:fs');
const path = require('node:path');
const { createPluginBundle } = require('./plugin-bundle');

const arg = process.argv.indexOf('--out');
const output = path.resolve(arg >= 0 ? process.argv[arg + 1] : path.join('dist', 'html-figma-importer'));
const bundle = createPluginBundle();
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(bundle.manifest, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'code.js'), bundle.code);
fs.writeFileSync(path.join(output, 'ui.html'), bundle.ui);
console.log(`Created ${output}`);
