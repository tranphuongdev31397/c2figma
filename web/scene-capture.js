(function (global) {
  const DEFAULTS = { width: 1440, height: 900, timeout: 15000 };

  function captureSceneGraph(html, options = {}) {
    const settings = { ...DEFAULTS, ...options };
    return new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe');
      const token = 'scene-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      let timer;
      let settled = false;

      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        iframe.remove();
        handler(value);
      };

      const onMessage = event => {
        if (event.source !== iframe.contentWindow || !event.data || event.data.token !== token) return;
        if (event.data.type === 'html-figma-scene') finish(resolve, event.data.scene);
        if (event.data.type === 'html-figma-scene-error') finish(reject, new Error(event.data.message));
      };

      window.addEventListener('message', onMessage);
      // ponytail: Claude bundles need same-origin to hydrate their internal blob resources;
      // keep the broader sandbox for ordinary HTML instead of weakening every upload.
      const needsBundleCompatibility = /__bundler\/(?:manifest|template|page_order)/.test(html);
      iframe.setAttribute('sandbox', needsBundleCompatibility ? 'allow-scripts allow-same-origin' : 'allow-scripts');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = [
        'position:fixed', 'left:-10000px', 'top:0', 'width:' + settings.width + 'px',
        'height:' + settings.height + 'px', 'border:0', 'opacity:0', 'pointer-events:none'
      ].join(';');
      document.body.appendChild(iframe);

      const minimumDelay = needsBundleCompatibility ? 3000 : 600;
      const script = '(' + captureWhenStable.toString() + ')((' + serializeScene.toString() + '),' + JSON.stringify(token) + ',' + settings.width + ',' + settings.height + ',' + minimumDelay + ');';
      const probe = '<script>' + script + '<\/script>';
      iframe.srcdoc = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, probe + '</body>') : html + probe;
      timer = setTimeout(() => finish(reject, new Error('Không thể dựng layout HTML trong thời gian cho phép.')), settings.timeout);
    });
  }

  function captureWhenStable(serialize, token, width, height, minimumDelay) {
    const started = Date.now();
    let previous = '';
    let stableTicks = 0;
    const check = () => {
      const body = document.body;
      const signature = [
        document.readyState,
        document.querySelectorAll('*').length,
        (body ? body.innerText : '').replace(/\s+/g, ' ').slice(0, 1000)
      ].join('|');
      if (signature === previous) stableTicks += 1;
      else { previous = signature; stableTicks = 0; }
      if (Date.now() - started >= minimumDelay && stableTicks >= 3) return serialize(token, width, height);
      if (Date.now() - started >= 10000) return serialize(token, width, height);
      setTimeout(check, 250);
    };
    setTimeout(check, 100);
  }

  function serializeScene(token, width, height) {
    try {
      const ignored = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'TEMPLATE']);
      const parseColor = value => {
        if (!value || value === 'transparent') return null;
        const clamp = channel => Math.max(0, Math.min(1, channel));
        const alpha = value => value === undefined ? 1 : clamp(Number(value.replace('%', '')) / (value.includes('%') ? 100 : 1));
        const rgb = (r, g, b, a = 1) => ({r:clamp(Number(r) / 255), g:clamp(Number(g) / 255), b:clamp(Number(b) / 255), a});
        const hex = value.match(/^#([0-9a-f]{3,8})$/i);
        if (hex) {
          const raw = hex[1].length <= 4 ? hex[1].split('').map(part => part + part).join('') : hex[1];
          return rgb(parseInt(raw.slice(0,2),16), parseInt(raw.slice(2,4),16), parseInt(raw.slice(4,6),16), raw.length === 8 ? parseInt(raw.slice(6,8),16) / 255 : 1);
        }
        const oklch = value.match(/^oklch\(\s*([\d.]+)(%)?\s+([\d.]+)(%)?\s+([\d.+-]+)(deg|rad|grad|turn)?(?:\s*\/\s*([\d.]+%?))?\s*\)$/i);
        if (oklch) {
          const L = Number(oklch[1]) / (oklch[2] ? 100 : 1), C = Number(oklch[3]) / (oklch[4] ? 100 : 1);
          const unit = oklch[6] || 'deg', angle = Number(oklch[5]) * (unit === 'rad' ? 1 : unit === 'grad' ? Math.PI / 200 : unit === 'turn' ? Math.PI * 2 : Math.PI / 180);
          const a = C * Math.cos(angle), b = C * Math.sin(angle), l = (L + 0.3963377774*a + 0.2158037573*b) ** 3, m = (L - 0.1055613458*a - 0.0638541728*b) ** 3, s = (L - 0.0894841775*a - 1.291485548*b) ** 3;
          const convert = channel => channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
          return {r:clamp(convert(4.0767416621*l - 3.3077115913*m + 0.2309699292*s)), g:clamp(convert(-1.2684380046*l + 2.6097574011*m - 0.3413193965*s)), b:clamp(convert(-0.0041960863*l - 0.7034186147*m + 1.707614701*s)), a:alpha(oklch[7])};
        }
        const match = value.match(/rgba?\(([^)]+)\)/i);
        if (!match) return null;
        const parts = match[1].replace('/', ',').split(',').map(part => part.trim());
        const channel = part => Number(part.replace('%', '')) * (part.includes('%') ? 2.55 : 1);
        return rgb(channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha(parts[3]));
      };
      const number = value => Number.parseFloat(value) || 0;
      const colorHex = value => {
        const color = parseColor(value) || { r: 0, g: 0, b: 0 };
        return '#' + [color.r, color.g, color.b].map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('');
      };
      const visible = (element, style, rect) => style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0 && rect.right >= 0 && rect.bottom >= 0 && rect.left <= width && rect.top <= height;
      const technical = element => element.id.startsWith('__bundler_') || element.closest('[id^="__bundler_"]');
      const payload = value => /(?:data:)?(?:text\/html|application\/json);base64,/i.test(value) || /^[A-Za-z0-9+/]{240,}={0,2}$/.test(value);
      const nameIndex = new Map();
      const semanticTags = { html: 'Document', body: 'Page', button: 'Button', input: 'Input', textarea: 'Textarea', table: 'Table', thead: 'Table header', tbody: 'Table body', tr: 'Row', th: 'Header cell', td: 'Cell', svg: 'Icon', img: 'Image', form: 'Form', ul: 'List', ol: 'List', li: 'List item' };
      const nameForElement = element => {
        const tag = element.tagName.toLowerCase();
        const className = (element.getAttribute('class') || '').split(/\s+/).find(Boolean);
        const label = element.getAttribute('aria-label') || element.getAttribute('data-testid') || element.getAttribute('data-name') || element.id || className;
        const base = label || semanticTags[tag] || 'Frame';
        const index = (nameIndex.get(base) || 0) + 1;
        nameIndex.set(base, index);
        return base + ' · ' + String(index).padStart(2, '0');
      };
      const nodes = [];
      const ids = new Map();
      const elements = [...document.querySelectorAll('*')].filter(element => !ignored.has(element.tagName));

      for (const element of elements) {
        const isSvg = element.tagName.toLowerCase() === 'svg';
        if (!isSvg && element.closest('svg')) continue;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (!visible(element, style, rect) || technical(element) || nodes.length >= 2000) continue;
        const id = 'n' + nodes.length;
        ids.set(element, id);
        let parent = element.parentElement;
        while (parent && !ids.has(parent)) parent = parent.parentElement;
        const border = {
          top: { width: number(style.borderTopWidth), color: parseColor(style.borderTopColor) },
          right: { width: number(style.borderRightWidth), color: parseColor(style.borderRightColor) },
          bottom: { width: number(style.borderBottomWidth), color: parseColor(style.borderBottomColor) },
          left: { width: number(style.borderLeftWidth), color: parseColor(style.borderLeftColor) }
        };
        const stroke = [border.top, border.right, border.bottom, border.left].find(side => side.width) || { width: 0, color: null };
        const radius = Math.max(number(style.borderTopLeftRadius), number(style.borderTopRightRadius), number(style.borderBottomRightRadius), number(style.borderBottomLeftRadius));
        const actionKey = element.getAttribute('data-c2figma-action-key');
        nodes.push({
          id,
          parentId: parent ? ids.get(parent) : null,
          kind: isSvg ? 'svg' : 'box',
          name: nameForElement(element),
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          fill: parseColor(style.backgroundColor),
          stroke: stroke.color,
          strokeWidth: stroke.width,
          borders: border,
          radius,
          position: style.position,
          overflow: style.overflow,
          opacity: Number(style.opacity) || 1,
          text: '',
          fontSize: number(style.fontSize),
          fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
          color: parseColor(style.color),
          svg: isSvg ? element.outerHTML.replace(/currentColor/gi, colorHex(style.color)) : null,
          ...(actionKey ? { actionKey } : {})
        });

        for (const child of element.childNodes) {
          if (child.nodeType !== 3 || !child.data.trim() || nodes.length >= 2000) continue;
          const range = document.createRange();
          range.selectNodeContents(child);
          const text = child.data.replace(/\s+/g, ' ').trim();
          if (payload(text)) continue;
          for (const textRect of [...range.getClientRects()]) {
            if (!text || textRect.width <= 0 || textRect.height <= 0) continue;
            nodes.push({
              id: 'n' + nodes.length,
              parentId: id,
              kind: 'text',
              name: 'Text / ' + text.slice(0, 40),
              x: textRect.left,
              y: textRect.top,
              width: textRect.width,
              height: textRect.height,
              fill: null,
              stroke: null,
              strokeWidth: 0,
              radius: 0,
              opacity: Number(style.opacity) || 1,
              text,
              fontSize: number(style.fontSize),
              fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
              color: parseColor(style.color)
            });
          }
        }

        if ((element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') && (element.value || element.placeholder)) {
          const text = element.value || element.placeholder;
          const textStyle = element.value ? style : getComputedStyle(element, '::placeholder');
          const lineHeight = number(style.lineHeight) || number(style.fontSize);
          nodes.push({
            id: 'n' + nodes.length,
            parentId: id,
            kind: 'text',
            name: 'Text / ' + text.slice(0, 40),
            x: rect.left + number(style.borderLeftWidth) + number(style.paddingLeft),
            y: rect.top + (rect.height - lineHeight) / 2,
            width: Math.max(1, rect.width - number(style.borderLeftWidth) - number(style.borderRightWidth) - number(style.paddingLeft) - number(style.paddingRight)),
            height: lineHeight,
            fill: null,
            stroke: null,
            strokeWidth: 0,
            radius: 0,
            opacity: Number(style.opacity) || 1,
            text,
            fontSize: number(style.fontSize),
            fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
            color: parseColor(textStyle.color || style.color)
          });
        }
      }

      const scene = { version: 1, viewport: { width, height }, nodes };
      if (!token) return scene;
      parent.postMessage({
        type: 'html-figma-scene',
        token,
        scene
      }, '*');
    } catch (error) {
      if (!token) throw error;
      parent.postMessage({ type: 'html-figma-scene-error', token, message: error.message }, '*');
    }
  }

  function actionKeyFor(element, occurrence) {
    const raw = element.getAttribute('data-c2figma-action')
      || element.id
      || element.getAttribute('aria-label')
      || element.getAttribute('data-action')
      || element.textContent
      || element.tagName;
    const slug = raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 48) || 'action';
    return `action-${slug}-${String(occurrence).padStart(2, '0')}`;
  }

  function captureInteractivePath(actionKeyFor, serialize, token, width, height, settleMs, actionPath) {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
        && rect.width > 0 && rect.height > 0 && rect.right >= 0 && rect.bottom >= 0;
    };
    const discover = () => {
      const selectors = 'button,a,summary,select,input,textarea,[role="button"],[aria-expanded],[aria-haspopup],[data-action],[data-state],[onclick],[style*="cursor: pointer"]';
      const seen = new Set();
      return [...document.querySelectorAll(selectors)].filter(element => {
        if (seen.has(element) || !visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
        const role = (element.getAttribute('role') || '').toLowerCase();
        if (element.getAttribute('aria-hidden') === 'true' || role === 'presentation' || role === 'none') return false;
        if (element.tagName === 'A' && /^(?:https?|ftp|data|javascript|mailto|tel):/i.test(element.href)) return false;
        seen.add(element);
        return true;
      }).map((element, index) => {
        const key = actionKeyFor(element, index + 1);
        element.setAttribute('data-c2figma-action-key', key);
        return { element, key, label: (element.getAttribute('aria-label') || element.textContent || element.tagName).trim().replace(/\s+/g, ' ').slice(0, 80), trigger: 'ON_CLICK' };
      });
    };
    const waitForStable = () => new Promise(resolve => {
      let previous = '';
      let stableTicks = 0;
      const check = () => {
        const signature = [document.readyState, document.querySelectorAll('*').length, document.body ? document.body.innerText : ''].join('|');
        if (signature === previous) stableTicks += 1;
        else { previous = signature; stableTicks = 0; }
        if (stableTicks >= 2) return resolve();
        setTimeout(check, 40);
      };
      check();
    });
    (async () => {
      try {
        await waitForStable();
        for (let depth = 0; depth < actionPath.length; depth += 1) {
          const candidates = discover();
          const candidate = candidates.find(item => item.key === actionPath[depth]);
          if (!candidate) throw new Error('Không tìm thấy hành động ' + actionPath[depth]);
          candidate.element.click();
          await sleep(settleMs);
        }
        const candidates = discover();
        const scene = serialize('', width, height);
        parent.postMessage({ type: 'html-figma-state', token, scene, actions: candidates.map(({ key, label, trigger }) => ({ key, label, trigger })) }, '*');
      } catch (error) {
        parent.postMessage({ type: 'html-figma-state-error', token, message: error.message }, '*');
      }
    })();
  }

  function sceneFingerprint(scene) {
    return JSON.stringify(scene.nodes.map(node => ({
      kind: node.kind,
      bounds: [node.x, node.y, node.width, node.height].map(value => Math.round(value * 10) / 10),
      text: node.text || '',
      fill: node.fill,
      stroke: node.stroke,
      opacity: node.opacity,
      visibility: node.visibility !== false
    })));
  }

  function captureStateGraph(html, options = {}, onState) {
    const settings = {
      width: 1440, height: 900, maxDepth: 2, maxStates: 8, maxActionsPerState: 8,
      stateTimeoutMs: 1500, settleMs: 80, ...options
    };
    const needsBundleCompatibility = /__bundler\/(?:manifest|template|page_order)/.test(html);
    const runPath = actionPath => new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe');
      const token = 'state-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      let timer;
      const finish = (handler, value) => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        iframe.remove();
        handler(value);
      };
      const onMessage = event => {
        if (event.source !== iframe.contentWindow || !event.data || event.data.token !== token) return;
        if (event.data.type === 'html-figma-state') finish(resolve, event.data);
        if (event.data.type === 'html-figma-state-error') finish(reject, new Error(event.data.message));
      };
      window.addEventListener('message', onMessage);
      iframe.setAttribute('sandbox', needsBundleCompatibility ? 'allow-scripts allow-same-origin' : 'allow-scripts');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = ['position:fixed', 'left:-10000px', 'top:0', 'width:' + settings.width + 'px', 'height:' + settings.height + 'px', 'border:0', 'opacity:0', 'pointer-events:none'].join(';');
      document.body.appendChild(iframe);
      const script = '(' + captureInteractivePath.toString() + ')((' + actionKeyFor.toString() + '),(' + serializeScene.toString() + '),' + JSON.stringify(token) + ',' + settings.width + ',' + settings.height + ',' + settings.settleMs + ',' + JSON.stringify(actionPath) + ');';
      const probe = '<script>' + script + '<\/script>';
      iframe.srcdoc = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, probe + '</body>') : html + probe;
      timer = setTimeout(() => finish(reject, new Error('State capture timed out.')), settings.stateTimeoutMs);
    });

    return (async () => {
      const graph = { version: 2, viewport: { width: settings.width, height: settings.height }, states: [], transitions: [] };
      const fingerprintToState = new Map();
      const transitionKeys = new Set();
      const baseline = await runPath([]);
      const addState = async (actionPath, result, label) => {
        const fingerprint = sceneFingerprint(result.scene);
        let state = fingerprintToState.get(fingerprint);
        if (!state) {
          if (graph.states.length >= settings.maxStates) return null;
          state = { id: 'state-' + String(graph.states.length).padStart(2, '0'), label, actionPath, scene: result.scene };
          fingerprintToState.set(fingerprint, state);
          graph.states.push(state);
          if (onState) await onState(state, graph);
        }
        return state;
      };
      const first = await addState([], baseline, 'Default');
      const queue = [{ state: first, actions: baseline.actions, depth: 0 }];
      const expanded = new Set();
      while (queue.length && graph.states.length < settings.maxStates) {
        const current = queue.shift();
        if (!current.state || current.depth >= settings.maxDepth) continue;
        if (expanded.has(current.state.id)) continue;
        expanded.add(current.state.id);
        for (const action of current.actions.slice(0, settings.maxActionsPerState)) {
          const actionPath = current.state.actionPath.concat(action.key);
          let result;
          try { result = await runPath(actionPath); } catch (_) { continue; }
          const destination = await addState(actionPath, result, action.label || action.key);
          if (!destination) continue;
          const transitionKey = [current.state.id, destination.id, action.key].join('|');
          if (!transitionKeys.has(transitionKey)) {
            transitionKeys.add(transitionKey);
            graph.transitions.push({ from: current.state.id, to: destination.id, actionKey: action.key, trigger: 'ON_CLICK' });
          }
          if (!expanded.has(destination.id)) queue.push({ state: destination, actions: result.actions, depth: current.depth + 1 });
        }
      }
      return graph;
    })();
  }

  global.captureSceneGraph = captureSceneGraph;
  global.captureStateGraph = captureStateGraph;
})(window);
