const fs = require('node:fs');
const path = require('node:path');

function createPluginBundle() {
  const webRoot = path.join(__dirname, '..', 'web');
  let ui = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
  ui = ui.replace(/<script src="\/(scene-capture|plugin-code)\.js"><\/script>/g, (tag, asset) => {
    const source = fs.readFileSync(path.join(webRoot, asset + '.js'), 'utf8');
    return `<script>\n${source}\n<\/script>`;
  });
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
    ui
  };
}

module.exports = { createPluginBundle };
