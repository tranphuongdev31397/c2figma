const solid = (value, opacity = 1) => ({ type: 'SOLID', color: { r: value.r, g: value.g, b: value.b }, opacity: (value.a ?? 1) * opacity });
const fontStyle = weight => weight >= 700 ? 'Bold' : weight >= 600 ? 'Semi Bold' : 'Regular';

async function renderScene(scene, title) {
  if (!scene || scene.version !== 1 || !scene.viewport || !Array.isArray(scene.nodes)) throw new Error('Scene HTML không hợp lệ.');
  const page = figma.createPage();
  page.name = 'HTML Visual • ' + title;
  const root = figma.createFrame();
  root.name = 'Screen / ' + title;
  root.resize(Math.max(1, scene.viewport.width), Math.max(1, scene.viewport.height));
  root.layoutMode = 'NONE';
  root.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  page.appendChild(root);
  const byId = new Map([['__root__', root]]);
  const bounds = new Map([['__root__', { x: 0, y: 0 }]]);
  const positioned = [];

  for (const item of scene.nodes) {
    const parent = byId.get(item.parentId) || root;
    const parentBounds = bounds.get(item.parentId) || bounds.get('__root__');
    const node = item.kind === 'text' ? figma.createText() : item.kind === 'svg' ? figma.createNodeFromSvg(item.svg) : figma.createFrame();
    node.name = item.name || item.kind;
    node.x = Math.round(item.x - parentBounds.x);
    node.y = Math.round(item.y - parentBounds.y);
    node.resize(Math.max(1, Math.round(item.width)), Math.max(1, Math.round(item.height)));
    node.opacity = Math.max(0, Math.min(1, item.opacity ?? 1));

    if (item.kind === 'text') {
      const style = fontStyle(item.fontWeight);
      await figma.loadFontAsync({ family: 'Inter', style });
      node.fontName = { family: 'Inter', style };
      node.characters = item.text || '';
      node.fontSize = Math.max(1, item.fontSize || 14);
      node.fills = [solid(item.color || { r: .1, g: .1, b: .1 })];
      node.textAutoResize = 'WIDTH_AND_HEIGHT';
    } else if (item.kind !== 'svg') {
      node.layoutMode = 'NONE';
      node.fills = item.fill ? [solid(item.fill)] : [];
      if (item.stroke && item.strokeWidth) {
        node.strokes = [solid(item.stroke)];
        node.strokeWeight = Math.max(1, item.strokeWidth);
      }
      if (item.radius) node.cornerRadius = item.radius;
    }

    parent.appendChild(node);
    if (item.position === 'absolute' || item.position === 'fixed' || item.position === 'sticky') positioned.push({ parent, node });
    byId.set(item.id, node);
    bounds.set(item.id, { x: item.x, y: item.y });
  }
  for (const item of positioned) item.parent.appendChild(item.node);
  await figma.setCurrentPageAsync(page);
  figma.closePlugin('Đã tạo design editable từ HTML.');
}

figma.showUI(__html__, { width: 720, height: 620 });
figma.ui.onmessage = async message => {
  if (message.type !== 'import') return;
  try {
    const title = message.spec?.title || 'Imported HTML';
    await renderScene(message.scene, title);
    figma.notify('Đã tạo design editable trong Figma.');
    figma.ui.postMessage({ type: 'imported', title });
  } catch (error) {
    figma.notify('Không thể tạo design: ' + error.message, { error: true });
    figma.ui.postMessage({ type: 'error', message: error.message });
  }
};
