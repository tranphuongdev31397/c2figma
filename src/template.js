function manifest() {
  return JSON.stringify({
    name: 'HTML Visual Import',
    api: '1.0.0',
    main: 'code.js',
    editorType: ['figma']
  }, null, 2);
}

function pluginCode(spec) {
  const data = JSON.stringify(spec).replace(/</g, '\\u003c');
  return `const SPEC = ${data};
const C = { white:{r:1,g:1,b:1}, text:{r:.1,g:.1,b:.1}, sub:{r:.32,g:.32,b:.32}, muted:{r:.98,g:.98,b:.97}, line:{r:.9,g:.9,b:.9}, green:{r:.086,g:.6,b:.231}, greenBg:{r:.922,g:.953,b:.878} };
const solid = (color, opacity=1) => ({ type:'SOLID', color, opacity });
const paint = (node, color) => { node.fills=[solid(color)]; };
const rect = (parent, name, x, y, w, h, color=C.white, radius=0) => { const n=figma.createFrame(); n.name=name; paint(n,color); n.x=x; n.y=y; n.resize(w,h); n.layoutMode='NONE'; if(radius)n.cornerRadius=radius; parent.appendChild(n); return n; };
async function t(parent, value, x, y, w, size=14, style='Regular', color=C.text) { const n=figma.createText(); await figma.loadFontAsync({family:'Inter',style}); n.fontName={family:'Inter',style}; n.characters=value; n.fontSize=size; n.fills=[solid(color)]; n.textAutoResize='HEIGHT'; n.x=x; n.y=y; n.resize(w,Math.max(18,size*1.35)); parent.appendChild(n); return n; }
async function main() {
  const page=figma.createPage(); page.name='HTML Visual • '+SPEC.title;
  const root=rect(page,'Screen / '+SPEC.title,0,0,1440,900,C.muted);
  const side=rect(root,'Sidebar',0,0,264,900,C.white); side.strokes=[solid(C.line)]; side.strokeWeight=1;
  await t(side,SPEC.title,24,24,190,17,'Semi Bold');
  const mark=rect(side,'Brand mark',202,18,34,34,C.green,9); await t(mark,'S',0,8,34,16,'Bold',C.white);
  await t(side,'NAVIGATION',14,88,220,11,'Semi Bold',C.sub);
  (SPEC.headings.length ? SPEC.headings : ['Overview']).slice(0,6).forEach(async (label,i)=>{ const row=rect(side,'Nav / '+label,14,110+i*42,236,38,i===0?C.greenBg:C.white,8); await t(row,label,40,10,178,13,i===0?'Semi Bold':'Regular',i===0?C.green:C.sub); });
  const main=rect(root,'Main content',264,0,1176,900,C.muted);
  const head=rect(main,'Page header',0,0,1176,96,C.white); head.strokes=[solid(C.line)]; head.strokeWeight=1;
  await t(head,SPEC.title,24,24,500,21,'Semi Bold');
  const body=rect(main,'Content',24,116,1128,720,C.white,10); body.strokes=[solid(C.line)]; body.strokeWeight=1;
  await t(body,SPEC.headings[1]||SPEC.title,20,20,580,16,'Semi Bold');
  await t(body,'Generated visual scaffold — refine mapping for this HTML when needed.',20,48,700,12,'Regular',C.sub);
  const labels=SPEC.labels.length?SPEC.labels:['Primary action','Secondary action','Active'];
  labels.slice(0,5).forEach(async (label,i)=>{ const row=rect(body,'Content / '+label,20,94+i*58,1088,48,C.white,8); row.strokes=[solid(C.line)]; row.strokeWeight=1; await t(row,label,18,14,560,13,i===0?'Semi Bold':'Regular'); });
  console.assert(root.width===1440 && root.height===900,'Expected desktop screen');
  figma.currentPage=page; figma.closePlugin('Created editable visual scaffold.');
}
main();`;
}

module.exports = { manifest, pluginCode };
