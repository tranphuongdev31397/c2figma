function manifest() {
  return JSON.stringify({ name: 'HTML Visual Import', api: '1.0.0', main: 'code.js', editorType: ['figma'] }, null, 2);
}

function pluginCode(spec) {
  const data = JSON.stringify(spec.scene || null).replace(/</g, '\\u003c');
  const title = JSON.stringify(spec.title).replace(/</g, '\\u003c');
  const pageName = JSON.stringify(spec.pageName || spec.fileName || spec.title || 'Imported HTML').replace(/</g, '\\u003c');
  const graph = JSON.stringify(spec.graph || null).replace(/</g, '\\u003c');
  return `const SCENE = ${data};
const PAGE_NAME = ${pageName};
const GRAPH = ${graph};
const solid = v => ({type:'SOLID', color:{r:v.r,g:v.g,b:v.b}, opacity:(v.a ?? 1)});
const style = w => w >= 700 ? 'Bold' : w >= 600 ? 'Semi Bold' : 'Regular';
const uniquePageName = base => { const wanted=String(base || 'Imported HTML').trim() || 'Imported HTML', names=new Set(figma.root.children.map(page=>page.name)); if(!names.has(wanted)) return wanted; let index=2; while(names.has(wanted+' '+index)) index += 1; return wanted+' '+index; };
const yieldToFigma = () => new Promise(resolve => setTimeout(resolve, 0));
async function renderScene(scene, pageName, title) {
  if (!scene) return;
  const page=figma.createPage(); page.name=uniquePageName(pageName || title); await figma.setCurrentPageAsync(page);
  const root=figma.createFrame(); root.name='Screen / '+title; root.resize(scene.viewport.width,scene.viewport.height); root.layoutMode='NONE'; root.fills=[{type:'SOLID',color:{r:1,g:1,b:1}}]; page.appendChild(root);
  const nodes=new Map([['__root__',root]]), bounds=new Map([['__root__',{x:0,y:0}]]), positioned=[];
  for (let index=0; index<scene.nodes.length; index+=1) { const item=scene.nodes[index], parent=nodes.get(item.parentId)||root, pb=bounds.get(item.parentId)||bounds.get('__root__'), node=item.kind==='text'?figma.createText():item.kind==='svg'?figma.createNodeFromSvg(item.svg):figma.createFrame(); node.name=item.name||item.kind; node.x=item.x-pb.x; node.y=item.y-pb.y; node.resize(Math.max(1,item.width),Math.max(1,item.height)); node.opacity=item.opacity ?? 1;
    if(item.kind==='text'){const fs=style(item.fontWeight);await figma.loadFontAsync({family:'Inter',style:fs});node.fontName={family:'Inter',style:fs};node.characters=item.text||'';node.fontSize=item.fontSize||14;node.fills=[solid(item.color||{r:.1,g:.1,b:.1})];node.textAutoResize='WIDTH_AND_HEIGHT';}
    else if(item.kind!=='svg'){node.layoutMode='NONE';node.clipsContent=['hidden','clip','auto','scroll'].includes(item.overflow);node.fills=item.fill?[solid(item.fill)]:[];const b=item.borders,w=b?{top:b.top.width,right:b.right.width,bottom:b.bottom.width,left:b.left.width}:{top:item.strokeWidth,right:item.strokeWidth,bottom:item.strokeWidth,left:item.strokeWidth},p=b?[b.top,b.right,b.bottom,b.left].find(s=>s.width)?.color:item.stroke;if(p&&Math.max(w.top,w.right,w.bottom,w.left)){node.strokes=[solid(p)];node.strokeWeight=Math.max(w.top,w.right,w.bottom,w.left);node.strokeTopWeight=w.top;node.strokeRightWeight=w.right;node.strokeBottomWeight=w.bottom;node.strokeLeftWeight=w.left;}if(item.radius)node.cornerRadius=item.radius;}
    parent.appendChild(node);if(item.position==='absolute'||item.position==='fixed'||item.position==='sticky')positioned.push({parent,node});nodes.set(item.id,node);bounds.set(item.id,{x:item.x,y:item.y}); if((index+1)%24===0||index+1===scene.nodes.length){await yieldToFigma();} }
  for (const item of positioned) item.parent.appendChild(item.node);
}
async function renderGraph(graph) {
  if (!graph || graph.version !== 2 || !Array.isArray(graph.states)) throw new Error('State graph HTML không hợp lệ.');
  for (const state of graph.states) await renderScene(state.scene, PAGE_NAME + ' · ' + state.label, ${title} + ' · ' + state.label);
}
async function main() {
  if (GRAPH) await renderGraph(GRAPH);
  else if (SCENE) await renderScene(SCENE, PAGE_NAME || ${title}, ${title});
  else { figma.notify('CLI chỉ tạo metadata; dùng plugin Direct Import để capture HTML sau khi render.'); }
  figma.closePlugin('Đã tạo design editable từ HTML.');
}
main();`;
}

module.exports = { manifest, pluginCode };
