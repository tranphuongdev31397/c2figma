function manifest() {
  return JSON.stringify({ name: 'HTML Visual Import', api: '1.0.0', main: 'code.js', editorType: ['figma'] }, null, 2);
}

function pluginCode(spec) {
  const data = JSON.stringify(spec.scene || null).replace(/</g, '\\u003c');
  const graph = JSON.stringify(spec.graph || null).replace(/</g, '\\u003c');
  const title = JSON.stringify(spec.title).replace(/</g, '\\u003c');
  const pageName = JSON.stringify(spec.pageName || spec.fileName || spec.title || 'Imported HTML').replace(/</g, '\\u003c');
  return `const SCENE = ${data};
const GRAPH = ${graph};
const PAGE_NAME = ${pageName};
const solid = v => ({type:'SOLID', color:{r:v.r,g:v.g,b:v.b}, opacity:(v.a ?? 1)});
const style = w => w >= 700 ? 'Bold' : w >= 600 ? 'Semi Bold' : 'Regular';
const uniquePageName = base => { const wanted=String(base || 'Imported HTML').trim() || 'Imported HTML', names=new Set(figma.root.children.map(page=>page.name)); if(!names.has(wanted)) return wanted; let index=2; while(names.has(wanted+' '+index)) index += 1; return wanted+' '+index; };
const yieldToFigma = () => new Promise(resolve => setTimeout(resolve, 0));
const TITLE = ${title};
const post = payload => { try { figma.ui.postMessage(payload); } catch (error) {} };
const triggers = new Set(['ON_CLICK','ON_HOVER','ON_PRESS','ON_DRAG','ON_KEY_DOWN','ON_KEY_UP','AFTER_TIMEOUT','MOUSE_ENTER','MOUSE_LEAVE']);
const STATE_GAP = 160;
// Figma has no z-index: a dropdown left nested in its container paints under whatever that container
// draws next. Hoist z-indexed layers to the frame, ordered by stacking ancestors then own level.
const stackLevel = item => { const level = Number.parseInt(item.zIndex, 10); return (item.position === 'absolute' || item.position === 'fixed') && Number.isFinite(level) ? level : null; };
const compareStack = (a, b) => { for (let i = 0; i < Math.max(a.zPath.length, b.zPath.length); i += 1) { const l = a.zPath[i], r = b.zPath[i]; if (l === r) continue; if (l === undefined) return -1; if (r === undefined) return 1; return l - r; } return a.index - b.index; };
async function renderScene(scene, title, pageName, target) {
  let page = target && target.page;
  if (!page) { page=figma.createPage(); page.name=uniquePageName(pageName || title); await figma.setCurrentPageAsync(page); if (target) target.page=page; }
  const root=figma.createFrame(); root.name='Screen / '+title; root.x=target?target.offsetX || 0:0; root.y=0; root.resize(scene.viewport.width,scene.viewport.height); root.layoutMode='NONE'; root.fills=[{type:'SOLID',color:{r:1,g:1,b:1}}]; page.appendChild(root);
  const nodes=new Map([['__root__',root]]), bounds=new Map([['__root__',{x:0,y:0}]]), actionNodes=new Map(), positioned=[], overlays=[], zPaths=new Map([['__root__',[]]]);
  for (let index=0; index<scene.nodes.length; index+=1) { const item=scene.nodes[index], level=stackLevel(item), zPath=level===null?(zPaths.get(item.parentId)||[]):(zPaths.get(item.parentId)||[]).concat(level), parent=level===null?nodes.get(item.parentId)||root:root, pb=level===null?bounds.get(item.parentId)||bounds.get('__root__'):bounds.get('__root__'), node=item.kind==='text'?figma.createText():item.kind==='svg'?figma.createNodeFromSvg(item.svg):figma.createFrame(); node.name=item.name||item.kind; node.x=item.x-pb.x; node.y=item.y-pb.y; node.resize(Math.max(1,item.width),Math.max(1,item.height)); node.opacity=item.opacity ?? 1;
    if(item.kind==='text'){const fs=style(item.fontWeight);await figma.loadFontAsync({family:'Inter',style:fs});node.fontName={family:'Inter',style:fs};node.characters=item.text||'';node.fontSize=item.fontSize||14;node.fills=[solid(item.color||{r:.1,g:.1,b:.1})];node.textAutoResize='WIDTH_AND_HEIGHT';}
    else if(item.kind!=='svg'){node.layoutMode='NONE';node.clipsContent=['hidden','clip','auto','scroll'].includes(item.overflow);node.fills=item.fill?[solid(item.fill)]:[];const b=item.borders,w=b?{top:b.top.width,right:b.right.width,bottom:b.bottom.width,left:b.left.width}:{top:item.strokeWidth,right:item.strokeWidth,bottom:item.strokeWidth,left:item.strokeWidth},p=b?[b.top,b.right,b.bottom,b.left].find(s=>s.width)?.color:item.stroke;if(p&&Math.max(w.top,w.right,w.bottom,w.left)){node.strokes=[solid(p)];node.strokeWeight=Math.max(w.top,w.right,w.bottom,w.left);node.strokeTopWeight=w.top;node.strokeRightWeight=w.right;node.strokeBottomWeight=w.bottom;node.strokeLeftWeight=w.left;}if(item.radius)node.cornerRadius=item.radius;}
    parent.appendChild(node);if(level!==null)overlays.push({zPath,index,node});else if(item.position==='absolute'||item.position==='fixed'||item.position==='sticky')positioned.push({parent,node});if(item.actionKey)actionNodes.set(item.actionKey,node);nodes.set(item.id,node);zPaths.set(item.id,zPath);bounds.set(item.id,{x:item.x,y:item.y}); if((index+1)%24===0||index+1===scene.nodes.length){await yieldToFigma();} }
  for (const item of positioned) item.parent.appendChild(item.node);
  overlays.sort(compareStack);
  for (const item of overlays) root.appendChild(item.node);
  if (target) target.offsetX = root.x + Math.max(1,scene.viewport.width) + STATE_GAP;
  return {root, actionNodes};
}
async function applyTransitions(graph, rendered) {
  let skipped=0;
  for (const transition of graph.transitions || []) {
    const source=rendered.get(transition.from), destination=rendered.get(transition.to), sourceNode=source?.actionNodes.get(transition.actionKey), trigger=transition.trigger || 'ON_CLICK';
    if(!sourceNode || !destination?.root || !triggers.has(trigger)){skipped+=1;continue;}
    try { await sourceNode.setReactionsAsync([{trigger:{type:trigger}, actions:[{type:'NODE', destinationId:destination.root.id, navigation:'NAVIGATE', transition:{type:'DISSOLVE', duration:0.2, easing:{type:'EASE_IN_AND_OUT'}}}]}]); }
    catch (error) { skipped+=1; }
  }
  if(skipped) figma.notify('Skipped '+skipped+' prototype transitions.', {error:true});
  return skipped;
}
async function renderGraph(graph) {
  const rendered=new Map(), target={page:null, offsetX:0};
  for (let index=0; index<graph.states.length; index+=1) {
    const state=graph.states[index];
    if(!state?.id || rendered.has(state.id)) continue;
    const scene=await renderScene(state.scene, state.label || TITLE, PAGE_NAME || TITLE, target);
    scene.root.name='State / '+(state.label || state.id);
    rendered.set(state.id, scene);
    post({type:'state-progress', current:index+1, total:graph.states.length, title:TITLE});
  }
  await applyTransitions(graph, rendered);
}
async function main() {
  try {
    if (GRAPH && GRAPH.version === 2 && Array.isArray(GRAPH.states) && GRAPH.states.length) { await renderGraph(GRAPH); figma.closePlugin('Đã tạo design editable từ HTML.'); return; }
    if (!SCENE) { figma.notify('CLI chỉ tạo metadata; dùng plugin Direct Import để capture HTML sau khi render.'); figma.closePlugin(); return; }
    await renderScene(SCENE, TITLE, PAGE_NAME);
    figma.closePlugin('Đã tạo design editable từ HTML.');
  } catch (error) {
    figma.notify('Không thể tạo design: ' + error.message, {error:true});
    figma.closePlugin();
  }
}
main();`;
}

module.exports = { manifest, pluginCode };
