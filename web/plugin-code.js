(function (global) {
  global.pluginCode = function pluginCode(scene, pageName, title) {
    const data = JSON.stringify(scene || null).replace(/</g, '\\u003c');
    const requestedPageName = JSON.stringify(pageName || title || 'Imported HTML').replace(/</g, '\\u003c');
    const contentTitle = JSON.stringify(title || 'Imported HTML').replace(/</g, '\\u003c');
    return `const INITIAL_SCENE = ${data};
const DEFAULT_PAGE_NAME = ${requestedPageName};
const CONTENT_TITLE = ${contentTitle};
const solid = (color, opacity=1) => ({type:'SOLID', color, opacity});
const color = (value, fallback) => value ? {r:value.r,g:value.g,b:value.b} : fallback;
const paint = (node, value, opacity) => { node.fills = value ? [solid(color(value,{r:1,g:1,b:1}), (value.a ?? 1) * opacity)] : []; };
const fontStyle = weight => weight >= 700 ? 'Bold' : weight >= 600 ? 'Semi Bold' : 'Regular';
const uniquePageName = base => { const wanted=String(base || 'Imported HTML').trim() || 'Imported HTML', names=new Set(figma.root.children.map(page=>page.name)); if(!names.has(wanted)) return wanted; let index=2; while(names.has(wanted+' '+index)) index += 1; return wanted+' '+index; };
const yieldToFigma = () => new Promise(resolve => setTimeout(resolve, 0));
async function renderScene(scene, title, pageName) {
  if (!scene || scene.version !== 1 || !scene.viewport || !Array.isArray(scene.nodes)) throw new Error('Scene HTML không hợp lệ.');
  const page = figma.createPage();
  page.name = uniquePageName(pageName || title);
  const root = figma.createFrame();
  root.name = 'Screen / ' + title;
  root.resize(Math.max(1, scene.viewport.width), Math.max(1, scene.viewport.height));
  root.layoutMode = 'NONE';
  root.fills = [];
  page.appendChild(root);
  const byId = new Map([['__root__', root]]);
  const bounds = new Map([['__root__', {x:0,y:0}]]);
  const positioned = [];
  await figma.setCurrentPageAsync(page);
  for (let index = 0; index < scene.nodes.length; index += 1) {
    const item = scene.nodes[index];
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
      await figma.loadFontAsync({family:'Inter', style});
      node.fontName = {family:'Inter', style};
      node.characters = item.text || '';
      node.fontSize = Math.max(1, item.fontSize || 14);
      node.fills = [solid(color(item.color,{r:0.1,g:0.1,b:0.1}), item.color?.a ?? 1)];
      node.textAutoResize = 'WIDTH_AND_HEIGHT';
    } else if (item.kind !== 'svg') {
      node.layoutMode = 'NONE';
      node.clipsContent = ['hidden', 'clip', 'auto', 'scroll'].includes(item.overflow);
      paint(node, item.fill, 1);
      const borders = item.borders;
      const weights = borders ? {top:borders.top.width,right:borders.right.width,bottom:borders.bottom.width,left:borders.left.width} : {top:item.strokeWidth,right:item.strokeWidth,bottom:item.strokeWidth,left:item.strokeWidth};
      const borderPaint = borders ? [borders.top,borders.right,borders.bottom,borders.left].find(side => side.width)?.color : item.stroke;
      if (borderPaint && Math.max(weights.top, weights.right, weights.bottom, weights.left)) {
        node.strokes = [solid(color(borderPaint,{r:0.8,g:0.8,b:0.8}), borderPaint.a ?? 1)];
        node.strokeWeight = Math.max(weights.top, weights.right, weights.bottom, weights.left);
        node.strokeTopWeight = weights.top;
        node.strokeRightWeight = weights.right;
        node.strokeBottomWeight = weights.bottom;
        node.strokeLeftWeight = weights.left;
      }
      if (item.radius) node.cornerRadius = item.radius;
    }
    parent.appendChild(node);
    if (item.position === 'absolute' || item.position === 'fixed' || item.position === 'sticky') positioned.push({parent,node});
    byId.set(item.id, node);
    bounds.set(item.id, {x:item.x, y:item.y});
    if ((index + 1) % 24 === 0 || index + 1 === scene.nodes.length) { figma.ui.postMessage({type:'progress', current:index + 1, total:scene.nodes.length, title}); await yieldToFigma(); }
  }
  for (const item of positioned) item.parent.appendChild(item.node);
  return page.name;
}
figma.showUI(__html__, {width:720,height:620});
figma.ui.onmessage = async message => {
  if (message.type !== 'import') return;
  try {
    const title = message.spec?.title || CONTENT_TITLE || 'Imported HTML';
    const pageName = await renderScene(message.scene || INITIAL_SCENE, title, message.pageName || message.spec?.pageName || DEFAULT_PAGE_NAME);
    figma.notify('Đã tạo design editable trong Figma.');
    figma.ui.postMessage({type:'imported', title, pageName});
    figma.closePlugin('Đã tạo design editable từ HTML.');
  } catch (error) {
    figma.notify('Không thể tạo design: ' + error.message, {error:true});
    figma.ui.postMessage({type:'error', message:error.message});
  }
};`;
  };
})(window);
