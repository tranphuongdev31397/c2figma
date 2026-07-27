(function (global) {
  const DEFAULTS = { width: 1440, height: 900 };

  function withProbeFor(html, script) {
    const probe = '<script>' + script + '<\/script>';
    return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, probe + '</body>') : html + probe;
  }

  // ponytail: Claude bundles hydrate from internal blob resources, so every capture of one has to
  // outwait that. Both paths read the same profile — an interactive capture that settles faster than
  // the static one just times out before the page exists.
  function settleProfileFor(html) {
    const bundled = /__bundler\/(?:manifest|template|page_order)/.test(html);
    const minimumDelay = bundled ? 3000 : 600;
    return { bundled, minimumDelay, timeoutMs: minimumDelay + 12000 };
  }

  function captureSceneGraph(html, options = {}) {
    const profile = settleProfileFor(html);
    const settings = { ...DEFAULTS, timeout: profile.timeoutMs, ...options };
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
      iframe.setAttribute('sandbox', profile.bundled ? 'allow-scripts allow-same-origin' : 'allow-scripts');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = [
        'position:fixed', 'left:-10000px', 'top:0', 'width:' + settings.width + 'px',
        'height:' + settings.height + 'px', 'border:0', 'opacity:0', 'pointer-events:none'
      ].join(';');
      document.body.appendChild(iframe);

      const script = '(' + captureWhenStable.toString() + ')((' + serializeScene.toString() + '),' + JSON.stringify(token) + ',' + settings.width + ',' + settings.height + ',' + profile.minimumDelay + ');';
      iframe.srcdoc = withProbeFor(html, script);
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
      // an element mid-fade keeps the same signature for its whole animation, so a page that only
      // looks still is not settled until nothing is animating on it — but a page that animates
      // forever still has to be captured, so the rule lapses after the first seconds
      const animating = Date.now() - started < 5000
        && document.getAnimations && document.getAnimations().some(animation => animation.playState === 'running');
      if (signature === previous && !animating) stableTicks += 1;
      else { previous = signature; stableTicks = 0; }
      if (Date.now() - started >= minimumDelay && stableTicks >= 3) return serialize(token, width, height);
      if (Date.now() - started >= 10000) return serialize(token, width, height);
      setTimeout(check, 250);
    };
    setTimeout(check, 100);
  }

  function serializeScene(token, width, height) {
    try {
      // Out-waiting a fade is a race the capture keeps losing: a dialog remounts on its own schedule,
      // and for its first frames its own opacity is 0 while its children are already opaque — so what
      // the probe reads is half a dialog. These are Web Animations, which no injected stylesheet can
      // reach, so end them here instead: every animation jumps to its final frame, which is the state
      // a design file wants. An endless one refuses to finish and is left running.
      if (document.getAnimations) {
        for (const animation of document.getAnimations()) {
          try { animation.finish(); } catch (error) { /* infinite effect — nothing to land on */ }
        }
      }
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
      // Opacity is the one hiding rule a child cannot opt out of: at opacity 0 the whole subtree is
      // gone. Dropping only the faded element left its children behind as a ghost of the layer — a
      // dialog caught in the first frames of its fade lost its sheet and kept its contents.
      const faded = new Set();
      const underFaded = element => {
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (faded.has(ancestor)) return true;
        }
        return false;
      };

      for (const element of elements) {
        const isSvg = element.tagName.toLowerCase() === 'svg';
        if (!isSvg && element.closest('svg')) continue;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (Number(style.opacity) === 0 || underFaded(element)) { faded.add(element); continue; }
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
          zIndex: style.zIndex,
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

  // Shared by both probes; serialized into the iframe with toString(), so it must stay self-contained.
  function interactionToolkit(actionKeyFor, minimumDelay, settleMs) {
    const SETTLE_BUDGET_MS = 1200;
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
        const href = element.getAttribute('href') || '';
        if (element.tagName === 'A' && !href.startsWith('#') && /^(?:https?|ftp|data|javascript|mailto|tel):/i.test(element.href)) return false;
        seen.add(element);
        return true;
      }).map((element, index) => {
        const key = actionKeyFor(element, index + 1);
        element.setAttribute('data-c2figma-action-key', key);
        return { element, key, label: (element.getAttribute('aria-label') || element.textContent || element.tagName).trim().replace(/\s+/g, ' ').slice(0, 80), trigger: 'ON_CLICK' };
      });
    };
    const waitForStable = () => new Promise(resolve => {
      const started = Date.now();
      let previous = '';
      let stableTicks = 0;
      const check = () => {
        const signature = [document.readyState, document.querySelectorAll('*').length, document.body ? document.body.innerText : ''].join('|');
        if (signature === previous) stableTicks += 1;
        else { previous = signature; stableTicks = 0; }
        const waited = Date.now() - started;
        if (waited >= minimumDelay && stableTicks >= 2) return resolve();
        if (waited >= minimumDelay + 10000) return resolve();
        setTimeout(check, 40);
      };
      check();
    });
    // ponytail: the platform already tracks in-flight transitions; polling opacity would reinvent it badly.
    const waitForAnimations = async (budget = 1500) => {
      if (!document.getAnimations) return;
      const deadline = Date.now() + budget;
      while (Date.now() < deadline) {
        const running = document.getAnimations().filter(animation => animation.playState === 'running');
        if (!running.length) return;
        await Promise.race([
          Promise.all(running.map(animation => animation.finished.catch(() => {}))),
          sleep(250)
        ]);
      }
    };
    // The dialog remounts on a later tick, so a single look can find a calm page and serialize
    // straight into the fade that starts right after. Only a page still calm on a second look is
    // calm — under a ceiling, because a page that never goes quiet must not eat the path's budget.
    const settleAfterAction = async () => {
      const deadline = Date.now() + SETTLE_BUDGET_MS;
      let calm = 0;
      while (calm < 2 && Date.now() < deadline) {
        await sleep(settleMs);
        await waitForAnimations(deadline - Date.now());
        calm = document.getAnimations && document.getAnimations().some(animation => animation.playState === 'running') ? 0 : calm + 1;
      }
    };
    const replay = async actionPath => {
      for (let depth = 0; depth < actionPath.length; depth += 1) {
        const candidate = discover().find(item => item.key === actionPath[depth]);
        if (!candidate) throw new Error('Không tìm thấy hành động ' + actionPath[depth]);
        candidate.element.click();
        await settleAfterAction();
      }
    };
    const listActions = () => discover().map(({ key, label, trigger }) => ({ key, label, trigger }));
    return { sleep, visible, discover, waitForStable, waitForAnimations, settleAfterAction, replay, listActions };
  }

  function captureInteractivePath(toolkit, actionKeyFor, serialize, token, width, height, settleMs, actionPath, minimumDelay) {
    const tools = toolkit(actionKeyFor, minimumDelay, settleMs);
    (async () => {
      try {
        await tools.waitForStable();
        await tools.replay(actionPath);
        // Discovery is what stamps the action keys onto the elements, so it has to run against this
        // state before the scene is read — otherwise the scene carries the previous state's tags, or
        // on the baseline none at all, and every link out of it has no layer to start from.
        const actions = tools.listActions();
        parent.postMessage({ type: 'html-figma-state', token, scene: serialize('', width, height), actions }, '*');
      } catch (error) {
        parent.postMessage({ type: 'html-figma-state-error', token, message: error.message }, '*');
      }
    })();
  }

  // One iframe replays every path. Faster, because the page hydrates once, but each replay must first
  // undo the previous one — so it verifies it is back at the baseline and flags the result when not.
  function reusableProbe(toolkit, actionKeyFor, serialize, fingerprint, token, width, height, settleMs, minimumDelay) {
    const tools = toolkit(actionKeyFor, minimumDelay, settleMs);
    const snapshot = () => fingerprint(serialize('', width, height));
    let baseline = null;

    // ponytail: a dialog that advertises itself with a class or aria-label is the easy half. This app
    // renders its sheet as inline-styled divs with neither, so the backdrop has to be found by shape —
    // a viewport-sized positioned layer sitting over the page — and clicked.
    const dismissers = () => {
      const covering = element => {
        const rect = element.getBoundingClientRect();
        return rect.width >= innerWidth * 0.9 && rect.height >= innerHeight * 0.9;
      };
      const backdrops = [...document.body.querySelectorAll('*')].filter(element => {
        const position = getComputedStyle(element).position;
        return (position === 'fixed' || position === 'absolute') && covering(element) && tools.visible(element);
      }).reverse();
      const labelled = [...document.querySelectorAll('[data-close],[data-dismiss],[aria-label*="close" i],[aria-label*="đóng" i],[class*="close" i],[class*="backdrop" i],[class*="overlay" i]')]
        .filter(element => tools.visible(element));
      return [...backdrops, ...labelled];
    };

    // One pass, not three: a reload always restores the baseline, so a dance that has not worked once
    // is not worth repeating at a second and more per try. It stays as the cheap first attempt for
    // pages where Escape or a backdrop click is all it takes.
    const resetToBaseline = async () => {
      if (snapshot() === baseline) return true;
      // Escape has to bubble up from the focused element — frameworks listen on their own root, and
      // a keydown dispatched straight at `document` never reaches it.
      for (const target of [document.activeElement || document.body, document]) {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      }
      await tools.settleAfterAction();
      for (const dismisser of dismissers().slice(0, 4)) {
        if (snapshot() === baseline) return true;
        dismisser.click();
        await tools.settleAfterAction();
      }
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      return snapshot() === baseline;
    };

    window.addEventListener('message', async event => {
      const data = event.data;
      if (!data || data.token !== token || data.type !== 'run-path') return;
      try {
        // An action key carries the element's place in the discovered list, so a leftover dropdown
        // shifts every key after it and the replay asks for one that no longer exists. Replaying on
        // a page that is not back at the baseline cannot produce this path's state — say so and let
        // the runner reload, which is the one reset that always works.
        if (!await resetToBaseline()) {
          return parent.postMessage({ type: 'html-figma-state', token, requestId: data.requestId, degraded: true }, '*');
        }
        await tools.replay(data.actionPath);
        const actions = tools.listActions();
        parent.postMessage({
          type: 'html-figma-state', token, requestId: data.requestId,
          scene: serialize('', width, height), actions, degraded: false
        }, '*');
      } catch (error) {
        parent.postMessage({ type: 'html-figma-state-error', token, requestId: data.requestId, message: error.message }, '*');
      }
    });

    (async () => {
      try {
        await tools.waitForStable();
        baseline = snapshot();
        parent.postMessage({ type: 'html-figma-ready', token }, '*');
      } catch (error) {
        parent.postMessage({ type: 'html-figma-state-error', token, message: error.message }, '*');
      }
    })();
  }

  // ponytail: no opacity and whole-pixel bounds on purpose. A modal caught mid-fade differs from the
  // same modal at rest only in those two, so keeping them splits one state into a state per frame.
  function sceneFingerprint(scene) {
    return JSON.stringify(scene.nodes.map(node => ({
      kind: node.kind,
      bounds: [node.x, node.y, node.width, node.height].map(value => Math.round(value)),
      text: node.text || '',
      fill: node.fill,
      stroke: node.stroke,
      visibility: node.visibility !== false
    })));
  }

  // ponytail: depth is the real ceiling — it bounds how many paths run, and paths are what cost time.
  // A separate state cap only discarded states the run had already paid for.
  const LIMITS = { maxDepth: 2, maxActionsPerState: 8 };

  const CAPTURE_MODES = {
    fresh: 'Một iframe mới cho mỗi tương tác — chính xác nhất, chậm nhất.',
    reuse: 'Dùng lại một iframe, chỉ tải lại khi không đóng được modal — nhanh hơn một chút, cùng số state.'
  };
  const DEFAULT_CAPTURE_MODE = 'fresh';

  function captureStateGraph(html, options = {}, onState) {
    const profile = settleProfileFor(html);
    const settings = {
      width: 1440, height: 900, ...LIMITS,
      stateTimeoutMs: profile.timeoutMs, settleMs: 80, ...options
    };
    const makeIframe = token => {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', profile.bundled ? 'allow-scripts allow-same-origin' : 'allow-scripts');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.setAttribute('data-capture-token', token);
      iframe.style.cssText = ['position:fixed', 'left:-10000px', 'top:0', 'width:' + settings.width + 'px', 'height:' + settings.height + 'px', 'border:0', 'opacity:0', 'pointer-events:none'].join(';');
      return iframe;
    };
    const inject = (iframe, script) => { iframe.srcdoc = withProbeFor(html, script); };
    const newToken = prefix => prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);

    const runPath = actionPath => new Promise((resolve, reject) => {
      const token = newToken('state');
      const iframe = makeIframe(token);
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
      document.body.appendChild(iframe);
      inject(iframe, '(' + captureInteractivePath.toString() + ')((' + interactionToolkit.toString() + '),(' + actionKeyFor.toString() + '),(' + serializeScene.toString() + '),' + JSON.stringify(token) + ',' + settings.width + ',' + settings.height + ',' + settings.settleMs + ',' + JSON.stringify(actionPath) + ',' + profile.minimumDelay + ');');
      timer = setTimeout(() => finish(reject, new Error('State capture timed out.')), settings.stateTimeoutMs);
    });

    const reusableRunner = () => {
      const token = newToken('reuse');
      const iframe = makeIframe(token);
      const waiting = new Map();
      const probe = '(' + reusableProbe.toString() + ')((' + interactionToolkit.toString() + '),(' + actionKeyFor.toString() + '),(' + serializeScene.toString() + '),(' + sceneFingerprint.toString() + '),' + JSON.stringify(token) + ',' + settings.width + ',' + settings.height + ',' + settings.settleMs + ',' + profile.minimumDelay + ');';
      let requestIds = 0;
      let degraded = 0;
      let ready;
      let resolveReady;
      let rejectReady;
      const onMessage = event => {
        const data = event.data;
        if (event.source !== iframe.contentWindow || !data || data.token !== token) return;
        if (data.type === 'html-figma-ready') return resolveReady();
        const pending = waiting.get(data.requestId);
        if (!pending) {
          if (data.type === 'html-figma-state-error') rejectReady(new Error(data.message));
          return;
        }
        waiting.delete(data.requestId);
        clearTimeout(pending.timer);
        if (data.type === 'html-figma-state') pending.resolve(data);
        if (data.type === 'html-figma-state-error') pending.reject(new Error(data.message));
      };
      // re-assigning srcdoc reloads the page, which is the one reset that always works
      const boot = () => {
        ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        const readyTimer = setTimeout(() => rejectReady(new Error('Reused iframe không sẵn sàng.')), profile.timeoutMs);
        ready.then(() => clearTimeout(readyTimer), () => clearTimeout(readyTimer));
        inject(iframe, probe);
        return ready;
      };
      window.addEventListener('message', onMessage);
      document.body.appendChild(iframe);
      boot();
      const send = actionPath => {
        const requestId = requestIds += 1;
        const result = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error('State capture timed out.')); }, settings.stateTimeoutMs);
          waiting.set(requestId, { resolve, reject, timer });
        });
        iframe.contentWindow.postMessage({ type: 'run-path', token, requestId, actionPath }, '*');
        return result;
      };

      return {
        run: async actionPath => {
          await ready;
          const result = await send(actionPath);
          if (!result.degraded) return result;
          // the probe refused to replay onto a page it could not restore, because what it captured
          // there would be the leftover rather than this path. Reload — the one reset that always
          // works — and take the path again from a real baseline.
          degraded += 1;
          if (settings.onNotice) settings.onNotice({ type: 'reuse-degraded', degraded });
          await boot();
          const retry = await send(actionPath);
          if (retry.degraded) throw new Error('Không đưa được trang về trạng thái gốc để chụp lại.');
          return retry;
        },
        dispose: () => { window.removeEventListener('message', onMessage); iframe.remove(); },
        degradedCount: () => degraded
      };
    };

    const mode = CAPTURE_MODES[settings.mode] ? settings.mode : DEFAULT_CAPTURE_MODE;
    const runner = mode === 'reuse' ? reusableRunner() : { run: runPath, dispose() {}, degradedCount: () => 0 };

    return (async () => {
      const graph = { version: 2, viewport: { width: settings.width, height: settings.height }, states: [], transitions: [] };
      const fingerprintToState = new Map();
      const transitionKeys = new Set();
      // most paths dedupe into a state that already exists, so state count alone looks frozen for
      // long stretches; report attempted paths too.
      const progress = { attempted: 0, planned: 1 };
      const report = () => settings.onProgress && settings.onProgress({
        attempted: progress.attempted, planned: progress.planned, states: graph.states.length
      });
      const attempt = async actionPath => {
        try { return await runner.run(actionPath); }
        catch (_) { return null; }
        finally { progress.attempted += 1; report(); }
      };
      let baseline;
      try { baseline = await attempt([]); }
      catch (error) { runner.dispose(); throw error; }
      if (!baseline) { runner.dispose(); throw new Error('Không dựng được layout gốc.'); }
      const addState = async (actionPath, result, label) => {
        const fingerprint = sceneFingerprint(result.scene);
        let state = fingerprintToState.get(fingerprint);
        if (!state) {
          state = { id: 'state-' + String(graph.states.length).padStart(2, '0'), label, actionPath, scene: result.scene };
          fingerprintToState.set(fingerprint, state);
          graph.states.push(state);
          if (onState) await onState(state, graph);
        }
        return state;
      };
      const first = await addState([], baseline, 'Default');
      const enqueue = (queue, state, actions, depth) => {
        if (depth >= settings.maxDepth) return;
        progress.planned += Math.min(actions.length, settings.maxActionsPerState);
        queue.push({ state, actions, depth });
        report();
      };
      const queue = [];
      enqueue(queue, first, baseline.actions, 0);
      const expanded = new Set();
      while (queue.length) {
        const current = queue.shift();
        if (!current.state) continue;
        if (expanded.has(current.state.id)) continue;
        expanded.add(current.state.id);
        for (const action of current.actions.slice(0, settings.maxActionsPerState)) {
          const actionPath = current.state.actionPath.concat(action.key);
          const result = await attempt(actionPath);
          if (!result) continue;
          const destination = await addState(actionPath, result, action.label || action.key);
          if (!destination) continue;
          const transitionKey = [current.state.id, destination.id, action.key].join('|');
          if (!transitionKeys.has(transitionKey)) {
            transitionKeys.add(transitionKey);
            graph.transitions.push({ from: current.state.id, to: destination.id, actionKey: action.key, trigger: 'ON_CLICK' });
          }
          if (!expanded.has(destination.id)) enqueue(queue, destination, result.actions, current.depth + 1);
        }
      }
      runner.dispose();
      graph.capture = { mode, attempted: progress.attempted, degraded: runner.degradedCount() };
      return graph;
    })();
  }

  global.captureSceneGraph = captureSceneGraph;
  global.withProbeFor = withProbeFor;
  global.captureStateGraph = captureStateGraph;
  global.settleProfileFor = settleProfileFor;
  global.sceneFingerprintFor = sceneFingerprint;
  global.explorationLimits = LIMITS;
  global.captureModes = CAPTURE_MODES;
  global.defaultCaptureMode = DEFAULT_CAPTURE_MODE;
})(window);
