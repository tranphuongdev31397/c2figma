const solid = (value, opacity = 1) => ({ type: 'SOLID', color: { r: value.r, g: value.g, b: value.b }, opacity: (value.a ?? 1) * opacity });
const fontStyle = weight => weight >= 700 ? 'Bold' : weight >= 600 ? 'Semi Bold' : 'Regular';

const uniquePageName = base => {
  const wanted = String(base || 'Imported HTML').trim() || 'Imported HTML';
  const names = new Set(figma.root.children.map(page => page.name));
  if (!names.has(wanted)) return wanted;
  let index = 2;
  while (names.has(wanted + ' ' + index)) index += 1;
  return wanted + ' ' + index;
};
const yieldToFigma = () => new Promise(resolve => setTimeout(resolve, 0));

const STATE_GAP = 160;

// ponytail: `target` lets streamed states share one page. Figma navigates between frames on the same
// page, so a page per state only scattered the prototype across the file.
async function renderScene(scene, title, pageName, target) {
  if (!scene || scene.version !== 1 || !scene.viewport || !Array.isArray(scene.nodes)) throw new Error('Scene HTML không hợp lệ.');
  let page = target && target.page;
  if (!page) {
    page = figma.createPage();
    page.name = uniquePageName(pageName || title);
    if (target) target.page = page;
  }
  const root = figma.createFrame();
  root.name = 'Screen / ' + title;
  root.x = target ? target.offsetX || 0 : 0;
  root.y = 0;
  root.resize(Math.max(1, scene.viewport.width), Math.max(1, scene.viewport.height));
  root.layoutMode = 'NONE';
  root.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  page.appendChild(root);
  const byId = new Map([['__root__', root]]);
  const bounds = new Map([['__root__', { x: 0, y: 0 }]]);
  const actionNodes = new Map();
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
      await figma.loadFontAsync({ family: 'Inter', style });
      node.fontName = { family: 'Inter', style };
      node.characters = item.text || '';
      node.fontSize = Math.max(1, item.fontSize || 14);
      node.fills = [solid(item.color || { r: .1, g: .1, b: .1 })];
      node.textAutoResize = 'WIDTH_AND_HEIGHT';
    } else if (item.kind !== 'svg') {
      node.layoutMode = 'NONE';
      node.clipsContent = ['hidden', 'clip', 'auto', 'scroll'].includes(item.overflow);
      node.fills = item.fill ? [solid(item.fill)] : [];
      const borders = item.borders;
      const weights = borders ? { top: borders.top.width, right: borders.right.width, bottom: borders.bottom.width, left: borders.left.width } : { top: item.strokeWidth, right: item.strokeWidth, bottom: item.strokeWidth, left: item.strokeWidth };
      const borderPaint = borders ? [borders.top, borders.right, borders.bottom, borders.left].find(side => side.width)?.color : item.stroke;
      if (borderPaint && Math.max(weights.top, weights.right, weights.bottom, weights.left)) {
        node.strokes = [solid(borderPaint)];
        node.strokeWeight = Math.max(weights.top, weights.right, weights.bottom, weights.left);
        node.strokeTopWeight = weights.top;
        node.strokeRightWeight = weights.right;
        node.strokeBottomWeight = weights.bottom;
        node.strokeLeftWeight = weights.left;
      }
      if (item.radius) node.cornerRadius = item.radius;
    }

    parent.appendChild(node);
    if (item.position === 'absolute' || item.position === 'fixed' || item.position === 'sticky') positioned.push({ parent, node });
    if (item.actionKey) actionNodes.set(item.actionKey, node);
    byId.set(item.id, node);
    bounds.set(item.id, { x: item.x, y: item.y });
    if ((index + 1) % 24 === 0 || index + 1 === scene.nodes.length) {
      figma.ui.postMessage({ type: 'progress', current: index + 1, total: scene.nodes.length, title });
      await yieldToFigma();
    }
  }
  for (const item of positioned) item.parent.appendChild(item.node);
  if (target) target.offsetX = root.x + Math.max(1, scene.viewport.width) + STATE_GAP;
  return { page, root, actionNodes, pageName: page.name };
}

async function renderState(state, title, pageName, target) {
  if (!state || !state.id) throw new Error('State HTML không hợp lệ.');
  return { stateId: state.id, ...await renderScene(state.scene, state.label || title, pageName, target) };
}

const transitionTriggers = new Set(['ON_CLICK', 'ON_HOVER', 'ON_PRESS', 'ON_DRAG', 'ON_KEY_DOWN', 'ON_KEY_UP', 'AFTER_TIMEOUT', 'MOUSE_ENTER', 'MOUSE_LEAVE']);

async function applyTransitions(graph, renderedStates) {
  let applied = 0;
  let skipped = 0;
  for (const transition of graph.transitions || []) {
    const source = renderedStates.get(transition.from);
    const destination = renderedStates.get(transition.to);
    const sourceNode = source?.actionNodes.get(transition.actionKey);
    const trigger = transition.trigger || 'ON_CLICK';
    if (!sourceNode || !destination?.root || !transitionTriggers.has(trigger)) {
      skipped += 1;
      continue;
    }
    try {
      await sourceNode.setReactionsAsync([{
        trigger: { type: trigger },
        actions: [{
          type: 'NODE',
          destinationId: destination.root.id,
          navigation: 'NAVIGATE',
          transition: {
            type: 'DISSOLVE',
            duration: 0.2,
            easing: { type: 'EASE_IN_AND_OUT' }
          }
        }]
      }]);
      applied += 1;
    } catch (error) {
      skipped += 1;
    }
  }
  if (skipped) {
    figma.notify('Skipped ' + skipped + ' prototype transitions.', { error: true });
    figma.ui.postMessage({ type: 'transition-skipped', skipped });
  }
  return { applied, skipped };
}

const sessionFor = ({ spec, pageName } = {}) => {
  const title = spec?.title || 'Imported HTML';
  return {
    basePageName: pageName || spec?.pageName || title,
    title,
    states: new Map(),
    rendered: new Map(),
    target: { page: null, offsetX: 0 },
    queue: Promise.resolve(),
    failed: false
  };
};

async function renderOneState(state, current) {
  if (!state || !state.id) throw new Error('State HTML không hợp lệ.');
  if (current.rendered.has(state.id)) return current.rendered.get(state.id);
  current.states.set(state.id, state);
  const rendered = await renderState(state, current.title, current.basePageName, current.target);
  rendered.root.name = 'State / ' + (state.label || state.id);
  current.rendered.set(state.id, rendered);
  return rendered;
}

async function renderGraph(graph, title, pageName) {
  if (!graph || graph.version !== 2 || !Array.isArray(graph.states)) throw new Error('State graph không hợp lệ.');
  const current = sessionFor({ spec: { title }, pageName });
  for (let index = 0; index < graph.states.length; index += 1) {
    await renderOneState(graph.states[index], current);
    figma.ui.postMessage({ type: 'state-progress', current: index + 1, total: graph.states.length, title: current.title });
  }
  await applyTransitions(graph, current.rendered);
  return current;
}

let session;
let renderQueue = Promise.resolve();

function startSession(message) {
  session = sessionFor(message);
  session.queue = renderQueue;
}

function enqueue(current, work) {
  if (!current) return;
  renderQueue = renderQueue.then(() => current.failed || current !== session ? undefined : work());
  current.queue = renderQueue;
  return current.queue;
}

function reportFatal(error, current = session) {
  if (current) current.failed = true;
  figma.notify('Không thể tạo design: ' + error.message, { error: true });
  figma.ui.postMessage({ type: 'error', message: error.message });
}

function reportStateError(state, error) {
  const label = state?.label || state?.id || 'state';
  figma.notify('Không thể tạo state ' + label + ': ' + error.message, { error: true });
  figma.ui.postMessage({ type: 'import-error', message: label + ': ' + error.message });
}

function finishSession(current, standalone = false) {
  if (current.failed || (!standalone && current !== session)) return;
  figma.notify('Đã tạo design editable trong Figma.');
  figma.ui.postMessage({ type: 'imported', title: current.title, pageName: current.basePageName });
  figma.closePlugin('Đã tạo design editable từ HTML.');
}

figma.showUI(__html__, { width: 720, height: 620 });
figma.ui.onmessage = message => {
  if (message.type === 'import-start') {
    startSession(message);
    return;
  }
  if (message.type === 'import-state') {
    const current = session;
    const baseline = current && current.states.size === 0 && !message.state?.actionPath?.length;
    if (!current || current.states.has(message.state?.id)) return;
    current.states.set(message.state.id, message.state);
    enqueue(current, async () => {
      try {
        const rendered = await renderOneState(message.state, current);
        if (rendered) figma.ui.postMessage({ type: 'state-progress', current: current.rendered.size, total: current.states.size, title: current.title });
      } catch (error) {
        if (baseline) reportFatal(error, current);
        else reportStateError(message.state, error);
      }
    });
    return;
  }
  if (message.type === 'import-finish') {
    const current = session;
    enqueue(current, async () => {
      try {
        await applyTransitions(message.graph, current.rendered);
        finishSession(current);
      } catch (error) {
        reportFatal(error, current);
      }
    });
    return;
  }
  if (message.type === 'import-error') {
    reportFatal(new Error(message.message || 'Không thể khám phá state.'));
    return;
  }
  if (message.type !== 'import') return;
  (async () => {
    const title = message.spec?.title || 'Imported HTML';
    try {
      if (message.graph) {
        const current = await renderGraph(message.graph, title, message.pageName || message.spec?.pageName || title);
        finishSession(current, true);
        return;
      }
      const rendered = await renderScene(message.scene, title, message.pageName || message.spec?.pageName || title);
      figma.notify('Đã tạo design editable trong Figma.');
      figma.ui.postMessage({ type: 'imported', title, pageName: rendered.pageName });
      figma.closePlugin('Đã tạo design editable từ HTML.');
    } catch (error) {
      reportFatal(error);
    }
  })();
};
