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
const post = payload => { try { figma.ui.postMessage(payload); } catch (error) {} };
const STATE_GAP = 160;
// Figma has no z-index: a dropdown left nested in its container paints under whatever that container
// draws next. Hoist z-indexed layers to the frame, ordered by their stacking ancestors then own level.
const stackLevel = item => { const level = Number.parseInt(item.zIndex, 10); return (item.position === 'absolute' || item.position === 'fixed') && Number.isFinite(level) ? level : null; };
const compareStack = (a, b) => { for (let i = 0; i < Math.max(a.zPath.length, b.zPath.length); i += 1) { const l = a.zPath[i], r = b.zPath[i]; if (l === r) continue; if (l === undefined) return -1; if (r === undefined) return 1; return l - r; } return a.index - b.index; };
async function renderScene(scene, title, pageName, target) {
  if (!scene || scene.version !== 1 || !scene.viewport || !Array.isArray(scene.nodes)) throw new Error('Scene HTML không hợp lệ.');
  let page = target && target.page;
  if (!page) { page = figma.createPage(); page.name = uniquePageName(pageName || title); if (target) target.page = page; }
  const root = figma.createFrame();
  root.name = 'Screen / ' + title;
  root.x = target ? target.offsetX || 0 : 0;
  root.y = 0;
  root.resize(Math.max(1, scene.viewport.width), Math.max(1, scene.viewport.height));
  root.layoutMode = 'NONE';
  root.fills = [];
  page.appendChild(root);
  const byId = new Map([['__root__', root]]);
  const bounds = new Map([['__root__', {x:0,y:0}]]);
  const actionNodes = new Map();
  const positioned = [];
  const overlays = [];
  const zPaths = new Map([['__root__', []]]);
  await figma.setCurrentPageAsync(page);
  for (let index = 0; index < scene.nodes.length; index += 1) {
    const item = scene.nodes[index];
    const level = stackLevel(item);
    const zPath = level === null ? (zPaths.get(item.parentId) || []) : (zPaths.get(item.parentId) || []).concat(level);
    zPaths.set(item.id, zPath);
    const parent = level === null ? byId.get(item.parentId) || root : root;
    const parentBounds = level === null ? bounds.get(item.parentId) || bounds.get('__root__') : bounds.get('__root__');
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
    if (level !== null) overlays.push({zPath,index,node});
    else if (item.position === 'absolute' || item.position === 'fixed' || item.position === 'sticky') positioned.push({parent,node});
    if (item.actionKey) actionNodes.set(item.actionKey, node);
    byId.set(item.id, node);
    bounds.set(item.id, {x:item.x, y:item.y});
    if ((index + 1) % 24 === 0 || index + 1 === scene.nodes.length) { post({type:'progress', current:index + 1, total:scene.nodes.length, title}); await yieldToFigma(); }
  }
  for (const item of positioned) item.parent.appendChild(item.node);
  overlays.sort(compareStack);
  for (const item of overlays) root.appendChild(item.node);
  if (target) target.offsetX = root.x + Math.max(1, scene.viewport.width) + STATE_GAP;
  return {page, root, actionNodes, pageName:page.name};
}
const transitionTriggers = new Set(['ON_CLICK','ON_HOVER','ON_PRESS','ON_DRAG','ON_KEY_DOWN','ON_KEY_UP','AFTER_TIMEOUT','MOUSE_ENTER','MOUSE_LEAVE']);
async function applyTransitions(graph, renderedStates) {
  let skipped = 0;
  for (const transition of graph.transitions || []) {
    const source = renderedStates.get(transition.from);
    const destination = renderedStates.get(transition.to);
    const sourceNode = source?.actionNodes.get(transition.actionKey);
    const trigger = transition.trigger || 'ON_CLICK';
    if (!sourceNode || !destination?.root || !transitionTriggers.has(trigger)) { skipped += 1; continue; }
    try {
      await sourceNode.setReactionsAsync([{trigger:{type:trigger}, actions:[{type:'NODE', destinationId:destination.root.id, navigation:'NAVIGATE', transition:{type:'DISSOLVE', duration:0.2, easing:{type:'EASE_IN_AND_OUT'}}}]}]);
    } catch (error) { skipped += 1; }
  }
  if (skipped) { figma.notify('Skipped ' + skipped + ' prototype transitions.', {error:true}); post({type:'transition-skipped', skipped}); }
  return skipped;
}
async function renderGraph(graph, title, basePageName) {
  if (!graph || graph.version !== 2 || !Array.isArray(graph.states)) throw new Error('State graph không hợp lệ.');
  const rendered = new Map();
  const target = {page:null, offsetX:0};
  for (let index = 0; index < graph.states.length; index += 1) {
    const state = graph.states[index];
    if (!state?.id || rendered.has(state.id)) continue;
    const scene = await renderScene(state.scene, state.label || title, basePageName, target);
    scene.root.name = 'State / ' + (state.label || state.id);
    rendered.set(state.id, scene);
    post({type:'state-progress', current:index + 1, total:graph.states.length, title});
  }
  await applyTransitions(graph, rendered);
  return rendered;
}
// ponytail: index.html only appends STATE_GRAPH for interactive exports, so read it defensively instead of branching in the generator.
const embeddedGraph = () => { try { return STATE_GRAPH; } catch (error) { return null; } };
async function boot() {
  const graph = embeddedGraph();
  if (graph?.states?.length) {
    try {
      await renderGraph(graph, CONTENT_TITLE || 'Imported HTML', DEFAULT_PAGE_NAME || CONTENT_TITLE || 'Imported HTML');
      figma.closePlugin('Đã tạo design editable từ HTML.');
    } catch (error) {
      figma.notify('Không thể tạo design: ' + error.message, {error:true});
      figma.closePlugin();
    }
    return;
  }
  figma.showUI(__html__, {width:720,height:620});
  figma.ui.onmessage = async message => {
    if (message.type !== 'import') return;
    try {
      const title = message.spec?.title || CONTENT_TITLE || 'Imported HTML';
      const scene = await renderScene(message.scene || INITIAL_SCENE, title, message.pageName || message.spec?.pageName || DEFAULT_PAGE_NAME);
      figma.notify('Đã tạo design editable trong Figma.');
      post({type:'imported', title, pageName:scene.pageName});
      figma.closePlugin('Đã tạo design editable từ HTML.');
    } catch (error) {
      figma.notify('Không thể tạo design: ' + error.message, {error:true});
      post({type:'error', message:error.message});
    }
  };
}
setTimeout(boot, 0);`;
  };
})(window);
