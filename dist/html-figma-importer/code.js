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
const ROW_GAP = 260;
const COLUMNS = 4;
const DEPTH_LABELS = ['Trạng thái gốc', 'Sau 1 tương tác', 'Sau 2 tương tác'];

// One endless row of frames is unreadable. Each exploration depth opens its own row and a row wraps
// after COLUMNS, so the page reads as sections. States stream in breadth-first, so depth never goes
// backwards and a row's y only ever grows — no relayout of what is already on the page.
const placeState = (target, viewport, depth) => {
  if (!target) return { x: 0, y: 0, section: false };
  const section = !target.placed || target.depth !== depth;
  if (target.placed && (section || target.column >= COLUMNS)) {
    target.y = (target.y || 0) + viewport.height + ROW_GAP;
    target.column = 0;
  }
  target.depth = depth;
  target.placed = (target.placed || 0) + 1;
  const x = (target.column || 0) * (viewport.width + STATE_GAP);
  target.column = (target.column || 0) + 1;
  return { x, y: target.y || 0, section };
};

async function sectionLabel(page, spot, depth) {
  try {
    await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
    const label = figma.createText();
    label.fontName = { family: 'Inter', style: 'Bold' };
    label.characters = 'Cấp ' + depth + ' · ' + (DEPTH_LABELS[depth] || 'Sau ' + depth + ' tương tác');
    label.fontSize = 48;
    label.fills = [{ type: 'SOLID', color: { r: 0.45, g: 0.45, b: 0.45 } }];
    label.x = spot.x;
    label.y = spot.y - 96;
    page.appendChild(label);
  } catch (error) {
    // a missing font is not worth losing the states over
  }
}

// A dropdown or dialog escapes its container in CSS through z-index. Figma has no z-index, so leaving
// it nested buries it under whatever that container paints next — the table rows, in this app.
// `zPath` is the z-index of every stacking ancestor, so a menu inside a dialog still sorts above it.
const stackLevel = item => {
  const level = Number.parseInt(item.zIndex, 10);
  return (item.position === 'absolute' || item.position === 'fixed') && Number.isFinite(level) ? level : null;
};
const compareStack = (a, b) => {
  for (let index = 0; index < Math.max(a.zPath.length, b.zPath.length); index += 1) {
    const left = a.zPath[index];
    const right = b.zPath[index];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    return left - right;
  }
  return a.index - b.index;
};

// ponytail: `target` lets streamed states share one page. Figma navigates between frames on the same
// page, so a page per state only scattered the prototype across the file.
async function renderScene(scene, title, pageName, target, depth = 0) {
  if (!scene || scene.version !== 1 || !scene.viewport || !Array.isArray(scene.nodes)) throw new Error('Scene HTML không hợp lệ.');
  let page = target && target.page;
  if (!page) {
    page = figma.createPage();
    page.name = uniquePageName(pageName || title);
    if (target) target.page = page;
  }
  const spot = placeState(target, scene.viewport, depth);
  const root = figma.createFrame();
  root.name = 'Screen / ' + title;
  root.x = spot.x;
  root.y = spot.y;
  root.resize(Math.max(1, scene.viewport.width), Math.max(1, scene.viewport.height));
  root.layoutMode = 'NONE';
  root.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  page.appendChild(root);
  const byId = new Map([['__root__', root]]);
  const bounds = new Map([['__root__', { x: 0, y: 0 }]]);
  const actionNodes = new Map();
  const positioned = [];
  const overlays = [];
  const zPaths = new Map([['__root__', []]]);
  const issues = [];
  let built = 0;

  await figma.setCurrentPageAsync(page);
  if (spot.section) await sectionLabel(page, spot, depth);
  for (let index = 0; index < scene.nodes.length; index += 1) {
    const item = scene.nodes[index];
    try {
      const level = stackLevel(item);
      const inherited = zPaths.get(item.parentId) || [];
      const zPath = level === null ? inherited : inherited.concat(level);
      zPaths.set(item.id, zPath);
      const parent = level === null ? byId.get(item.parentId) || root : root;
      const parentBounds = level === null ? bounds.get(item.parentId) || bounds.get('__root__') : bounds.get('__root__');
      // An icon Figma refuses to import must cost one icon, not the whole state.
      const build = () => {
        if (item.kind === 'text') return figma.createText();
        if (item.kind !== 'svg') return figma.createFrame();
        try { return figma.createNodeFromSvg(item.svg); }
        catch (error) {
          issues.push({ name: item.name || item.kind, kind: item.kind, message: error.message });
          const placeholder = figma.createFrame();
          placeholder.fills = [];
          return placeholder;
        }
      };
      const node = build();
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
        // A run the page kept on one line stays on one line, however much wider Inter is than the
        // page's own font. A run the page itself wrapped has to keep wrapping, so pin the width it
        // wrapped inside and let Figma re-flow the height — left to grow, it overflows its bubble.
        if (item.lines > 1) {
          node.textAutoResize = 'HEIGHT';
          node.resize(Math.max(1, Math.round(item.width)), Math.max(1, Math.round(item.height)));
        } else {
          node.textAutoResize = 'WIDTH_AND_HEIGHT';
        }
      } else if (item.kind !== 'svg') {
        node.layoutMode = 'NONE';
        node.clipsContent = ['hidden', 'clip', 'auto', 'scroll'].includes(item.overflow);
        node.fills = item.fill ? [solid(item.fill)] : [];
        // A fill Figma accepts but does not keep leaves a see-through frame and no error — say so.
        if (item.fill && !(node.fills && node.fills.length)) issues.push({ name: node.name, kind: 'fill', message: 'Figma bỏ fill ' + JSON.stringify(item.fill) });
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
      if (level !== null) overlays.push({ zPath, index, node });
      else if (item.position === 'absolute' || item.position === 'fixed' || item.position === 'sticky') positioned.push({ parent, node });
      if (item.actionKey) actionNodes.set(item.actionKey, node);
      byId.set(item.id, node);
      bounds.set(item.id, { x: item.x, y: item.y });
      built += 1;
    } catch (error) {
      issues.push({ name: item.name || item.kind, kind: item.kind, message: error.message });
    }
    if ((index + 1) % 24 === 0 || index + 1 === scene.nodes.length) {
      figma.ui.postMessage({ type: 'progress', current: index + 1, total: scene.nodes.length, title });
      await yieldToFigma();
    }
  }
  for (const item of positioned) item.parent.appendChild(item.node);
  overlays.sort(compareStack);
  for (const item of overlays) root.appendChild(item.node);
  figma.ui.postMessage({ type: 'state-summary', title, nodes: scene.nodes.length, built, issues: issues.length });
  if (issues.length) {
    figma.ui.postMessage({ type: 'render-issues', title, total: issues.length, issues: issues.slice(0, 12) });
    figma.notify(title + ': bỏ qua ' + issues.length + ' layer lỗi (' + issues[0].name + ': ' + issues[0].message + ')', { error: true });
  }
  return { page, root, actionNodes, pageName: page.name, issues };
}

async function renderState(state, title, pageName, target) {
  if (!state || !state.id) throw new Error('State HTML không hợp lệ.');
  const depth = Array.isArray(state.actionPath) ? state.actionPath.length : 0;
  return { stateId: state.id, ...await renderScene(state.scene, state.label || title, pageName, target, depth) };
}

const transitionTriggers = new Set(['ON_CLICK', 'ON_HOVER', 'ON_PRESS', 'ON_DRAG', 'ON_KEY_DOWN', 'ON_KEY_UP', 'AFTER_TIMEOUT', 'MOUSE_ENTER', 'MOUSE_LEAVE']);

const transitionKey = transition => [transition.from, transition.to, transition.actionKey].join('|');

// `pending` mode wires only the transitions whose two ends already exist and leaves the rest for a
// later pass, so links appear alongside the pages instead of all at once when exploration ends.
async function applyTransitions(transitions, renderedStates, done, pending) {
  let applied = 0;
  let skipped = 0;
  // A bare count says a prototype link was lost but never which one or why, and the four reasons
  // want four different answers from whoever reads the log.
  const reasons = [];
  const note = (transition, reason) => {
    if (reasons.length < 12) reasons.push(transition.from + '→' + transition.to + ' (' + transition.actionKey + '): ' + reason);
  };
  for (const transition of transitions || []) {
    const key = transitionKey(transition);
    if (done && done.has(key)) continue;
    const source = renderedStates.get(transition.from);
    const destination = renderedStates.get(transition.to);
    const sourceNode = source?.actionNodes.get(transition.actionKey);
    const trigger = transition.trigger || 'ON_CLICK';
    if (pending && (!sourceNode || !destination?.root)) continue;
    if (!sourceNode || !destination?.root || !transitionTriggers.has(trigger)) {
      skipped += 1;
      note(transition, !sourceNode ? 'layer của hành động không có trong state nguồn'
        : !destination?.root ? 'state đích chưa dựng xong'
        : 'trigger không hỗ trợ: ' + trigger);
      if (done) done.add(key);
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
      if (done) done.add(key);
    } catch (error) {
      skipped += 1;
      note(transition, 'Figma từ chối reaction: ' + error.message);
      if (done) done.add(key);
    }
  }
  if (skipped) {
    figma.notify('Skipped ' + skipped + ' prototype transitions.', { error: true });
    figma.ui.postMessage({ type: 'transition-skipped', skipped, reasons });
  }
  if (applied) figma.ui.postMessage({ type: 'transition-progress', applied });
  return { applied, skipped };
}

const sessionFor = ({ spec, pageName } = {}) => {
  const title = spec?.title || 'Imported HTML';
  return {
    basePageName: pageName || spec?.pageName || title,
    title,
    states: new Map(),
    rendered: new Map(),
    target: { page: null, column: 0, y: 0, placed: 0, depth: null },
    linked: new Set(),
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
  await applyTransitions(graph.transitions, current.rendered, current.linked);
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

// ponytail: the plugin deliberately outlives its own import. Closing on success took the run log
// down with it before anyone could read, let alone download, the layers it had to skip.
function finishSession(current, standalone = false) {
  if (current.failed || (!standalone && current !== session)) return;
  figma.notify('Đã tạo design editable trong Figma.');
  figma.ui.postMessage({ type: 'imported', title: current.title, pageName: current.basePageName });
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
        await applyTransitions(message.transitions, current.rendered, current.linked, true);
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
        await applyTransitions(message.graph?.transitions, current.rendered, current.linked);
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
    } catch (error) {
      reportFatal(error);
    }
  })();
};
