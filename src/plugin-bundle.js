const fs = require('node:fs');
const path = require('node:path');

function createPluginBundle() {
  return {
    manifest: {
      name: 'HTML → Figma Direct Import',
      api: '1.0.0',
      main: 'code.js',
      ui: 'ui.html',
      documentAccess: 'dynamic-page',
      networkAccess: { allowedDomains: ['none'] },
      editorType: ['figma']
    },
    code: fs.readFileSync(path.join(__dirname, 'bridge-code.js'), 'utf8'),
    ui: fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8')
  };
}

module.exports = { createPluginBundle };
