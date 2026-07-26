const C = {
  white: { r: 1, g: 1, b: 1 },
  text: { r: .1, g: .1, b: .1 },
  sub: { r: .32, g: .32, b: .32 },
  muted: { r: .98, g: .98, b: .97 },
  line: { r: .9, g: .9, b: .9 },
  green: { r: .086, g: .6, b: .231 },
  greenBg: { r: .922, g: .953, b: .878 }
};

const solid = (color, opacity = 1) => ({ type: 'SOLID', color, opacity });
const paint = (node, color) => { node.fills = [solid(color)]; };
const rect = (parent, name, x, y, w, h, color = C.white, radius = 0) => {
  const node = figma.createFrame();
  node.name = name; paint(node, color); node.x = x; node.y = y; node.resize(w, h);
  node.layoutMode = 'NONE';
  if (radius) node.cornerRadius = radius;
  parent.appendChild(node);
  return node;
};
const text = async (parent, value, x, y, w, size = 14, style = 'Regular', color = C.text) => {
  const node = figma.createText();
  await figma.loadFontAsync({ family: 'Inter', style });
  node.fontName = { family: 'Inter', style }; node.characters = value; node.fontSize = size;
  node.fills = [solid(color)]; node.textAutoResize = 'HEIGHT'; node.x = x; node.y = y;
  node.resize(w, Math.max(18, size * 1.35)); parent.appendChild(node); return node;
};

async function render(spec) {
  const page = figma.createPage();
  page.name = 'HTML Visual • ' + spec.title;
  const root = rect(page, 'Screen / ' + spec.title, 0, 0, 1440, 900, C.muted);
  const side = rect(root, 'Sidebar', 0, 0, 264, 900, C.white);
  side.strokes = [solid(C.line)]; side.strokeWeight = 1;
  await text(side, spec.title, 24, 24, 190, 17, 'Semi Bold');
  const mark = rect(side, 'Brand mark', 202, 18, 34, 34, C.green, 9);
  await text(mark, 'S', 0, 8, 34, 16, 'Bold', C.white);
  await text(side, 'NAVIGATION', 14, 88, 220, 11, 'Semi Bold', C.sub);
  const headings = (spec.headings.length ? spec.headings : ['Overview']).slice(0, 6);
  for (let i = 0; i < headings.length; i++) {
    const row = rect(side, 'Nav / ' + headings[i], 14, 110 + i * 42, 236, 38, i ? C.white : C.greenBg, 8);
    await text(row, headings[i], 40, 10, 178, 13, i ? 'Regular' : 'Semi Bold', i ? C.sub : C.green);
  }
  const main = rect(root, 'Main content', 264, 0, 1176, 900, C.muted);
  const header = rect(main, 'Page header', 0, 0, 1176, 96, C.white);
  header.strokes = [solid(C.line)]; header.strokeWeight = 1;
  await text(header, spec.title, 24, 24, 500, 21, 'Semi Bold');
  const body = rect(main, 'Content', 24, 116, 1128, 720, C.white, 10);
  body.strokes = [solid(C.line)]; body.strokeWeight = 1;
  await text(body, spec.headings[1] || spec.title, 20, 20, 580, 16, 'Semi Bold');
  await text(body, 'Generated visual scaffold — refine mapping for this HTML when needed.', 20, 48, 700, 12, 'Regular', C.sub);
  const labels = spec.labels.length ? spec.labels : ['Primary action', 'Secondary action', 'Active'];
  for (let i = 0; i < Math.min(5, labels.length); i++) {
    const row = rect(body, 'Content / ' + labels[i], 20, 94 + i * 58, 1088, 48, C.white, 8);
    row.strokes = [solid(C.line)]; row.strokeWeight = 1;
    await text(row, labels[i], 18, 14, 560, 13, i ? 'Regular' : 'Semi Bold');
  }
  await figma.setCurrentPageAsync(page);
}

figma.showUI(__html__, { width: 720, height: 620 });
figma.ui.onmessage = async message => {
  if (message.type !== 'import') return;
  try {
    await render(message.spec);
    figma.notify('Đã tạo design editable trong Figma.');
    figma.ui.postMessage({ type: 'imported', title: message.spec.title });
  } catch (error) {
    figma.notify('Không thể tạo design: ' + error.message, { error: true });
    figma.ui.postMessage({ type: 'error', message: error.message });
  }
};
