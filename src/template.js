function manifest() {
  return JSON.stringify({ name: 'HTML Visual Import', api: '1.0.0', main: 'code.js', editorType: ['figma'] }, null, 2);
}

function pluginCode(spec) {
  const data = JSON.stringify(spec.scene || null).replace(/</g, '\\u003c');
  const title = JSON.stringify(spec.title).replace(/</g, '\\u003c');
  return `const SCENE = ${data};
const solid = v => ({type:'SOLID', color:{r:v.r,g:v.g,b:v.b}, opacity:(v.a ?? 1)});
const style = w => w >= 700 ? 'Bold' : w >= 600 ? 'Semi Bold' : 'Regular';
async function main() {
  if (!SCENE) { figma.notify('CLI chỉ tạo metadata; dùng plugin Direct Import để capture HTML sau khi render.'); figma.closePlugin(); return; }
  const page=figma.createPage(); page.name='HTML Visual • '+${title};
  const root=figma.createFrame(); root.name='Screen / '+${title}; root.resize(SCENE.viewport.width,SCENE.viewport.height); root.layoutMode='NONE'; root.fills=[{type:'SOLID',color:{r:1,g:1,b:1}}]; page.appendChild(root);
  const nodes=new Map([['__root__',root]]), bounds=new Map([['__root__',{x:0,y:0}]]), positioned=[];
  for (const item of SCENE.nodes) { const parent=nodes.get(item.parentId)||root, pb=bounds.get(item.parentId)||bounds.get('__root__'), node=item.kind==='text'?figma.createText():item.kind==='svg'?figma.createNodeFromSvg(item.svg):figma.createFrame(); node.name=item.name||item.kind; node.x=item.x-pb.x; node.y=item.y-pb.y; node.resize(Math.max(1,item.width),Math.max(1,item.height)); node.opacity=item.opacity ?? 1;
    if(item.kind==='text'){const fs=style(item.fontWeight);await figma.loadFontAsync({family:'Inter',style:fs});node.fontName={family:'Inter',style:fs};node.characters=item.text||'';node.fontSize=item.fontSize||14;node.fills=[solid(item.color||{r:.1,g:.1,b:.1})];node.textAutoResize='WIDTH_AND_HEIGHT';}
    else if(item.kind!=='svg'){node.layoutMode='NONE';node.fills=item.fill?[solid(item.fill)]:[];if(item.stroke&&item.strokeWidth){node.strokes=[solid(item.stroke)];node.strokeWeight=item.strokeWidth;}if(item.radius)node.cornerRadius=item.radius;}
    parent.appendChild(node);if(item.position==='absolute'||item.position==='fixed'||item.position==='sticky')positioned.push({parent,node});nodes.set(item.id,node);bounds.set(item.id,{x:item.x,y:item.y}); }
  for (const item of positioned) item.parent.appendChild(item.node);
  await figma.setCurrentPageAsync(page); figma.closePlugin('Đã tạo design editable từ HTML.');
}
main();`;
}

module.exports = { manifest, pluginCode };
