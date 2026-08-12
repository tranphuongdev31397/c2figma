(function (global) {
  const DEFAULTS = { width: 1440, height: 900 };

  function withProbeFor(html, script) {
    const probe = '<script>' + script + '<\/script>';
    return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, probe + '</body>') : html + probe;
  }

  // ponytail: Claude bundles hydrate from internal blob resources, so every capture of one has to
  // outwait that. Both paths read the same profile — an interactive capture that settles faster than
  // the static one just times out before the page exists.
  //
  // The floor used to be 3s for a bundle, and an exploration pays it once per path: measured on the
  // POS bundle, hydration finishes in 356ms, so ~2.6s of every ~8s path was spent asleep. A constant
  // cannot know what a page needs, so it is only the shortest wait worth taking — what actually ends
  // the wait is the page holding still for calmMs while showing something. A page that needs three
  // seconds keeps changing for three seconds and is still waited out; one that is ready in a third of
  // a second is no longer punished for it.
  function settleProfileFor(html) {
    const bundled = /__bundler\/(?:manifest|template|page_order)/.test(html);
    const minimumDelay = bundled ? 800 : 400;
    return { bundled, minimumDelay, calmMs: 500, timeoutMs: minimumDelay + 12000 };
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
      // A fixed-height panel with its own scrollbar still lays its overflowing rows out at their true
      // position; only the fixed viewport bound below dropped them, so widen that bound alone. What
      // is captured grows — every clipped row becomes a real layer — while nothing about how it is
      // drawn changes: the frames keep their measured size and their CSS overflow, so Figma clips
      // exactly like the browser did and unchecking "Clip content" reveals the rest. Growing frames
      // or forcing overflow:visible here instead only bought whitespace and lost the clip.
      let fullHeight = height;
      let fullWidth = width;
      for (const probe of document.querySelectorAll('*')) {
        if (ignored.has(probe.tagName)) continue;
        const probeStyle = getComputedStyle(probe);
        if (probeStyle.display === 'none' || probeStyle.visibility === 'hidden' || Number(probeStyle.opacity) === 0) continue;
        const probeRect = probe.getBoundingClientRect();
        if (probeRect.width <= 0 || probeRect.height <= 0) continue;
        if (probeRect.bottom > fullHeight) fullHeight = probeRect.bottom;
        if (probeRect.right > fullWidth) fullWidth = probeRect.right;
      }
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
      const visible = (element, style, rect) => style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0 && rect.right >= 0 && rect.bottom >= 0 && rect.left <= fullWidth && rect.top <= fullHeight;
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
          // getClientRects() returns one rect per visual line, so a node per rect wrote the whole
          // sentence once per line — a wrapped chat bubble came out with its text stamped twice, each
          // copy forced onto one line that overflowed the bubble. One node per run instead, boxed by
          // the union of its lines, with the line count so the renderer knows to let Figma re-wrap.
          const lineRects = [...range.getClientRects()].filter(line => line.width > 0 && line.height > 0);
          const box = range.getBoundingClientRect();
          if (text && lineRects.length) {
            nodes.push({
              id: 'n' + nodes.length,
              parentId: id,
              kind: 'text',
              name: 'Text / ' + text.slice(0, 40),
              x: box.left,
              y: box.top,
              width: box.width,
              height: box.height,
              lines: lineRects.length,
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
    // Controls built from one component are a candidate repeat — only a candidate: whether the group
    // really repeats is decided after the clicks, not here. Sharing a parent element is too strict a
    // test for that: the settings list renders every row in its own wrapper, which made seventeen
    // groups of one and let eleven near-identical states through. Rows built from one component share
    // the chain of tags and classes above them even when each sits in a wrapper of its own.
    const groupFor = element => {
      const parent = element.parentElement;
      const grandparent = parent && parent.parentElement;
      const step = node => node && node.getAttribute ? node.tagName + '.' + (node.getAttribute('class') || '') : '';
      return [step(element), step(parent), step(grandparent)].join('|');
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
        // one of a row of look-alike controls is explored; this opts a control out of that
        // != null on purpose: an empty attribute value is still the attribute being there
        const force = element.getAttribute('data-c2figma-force-explore') != null;
        return { element, key, force, group: groupFor(element), label: (element.getAttribute('aria-label') || element.textContent || element.tagName).trim().replace(/\s+/g, ' ').slice(0, 80), trigger: 'ON_CLICK' };
      });
    };
    // What ends this wait is the page holding still, not a clock: the same signature for CALM_MS while
    // it actually shows something. A bundle caught between its shell and its content is briefly empty
    // and briefly calm, so an empty page never counts as settled however quiet it looks. This is
    // hydration only — the wait after a click is settleAfterAction below, which is a different budget
    // and still takes two looks, because a dialog remounts on a later tick.
    const CALM_MS = 500;
    const waitForStable = () => new Promise(resolve => {
      const started = Date.now();
      let previous = '';
      let calmSince = 0;
      const check = () => {
        const signature = [document.readyState, document.querySelectorAll('*').length, document.body ? document.body.innerText : ''].join('|');
        const rendered = document.readyState !== 'loading' && !!document.body && document.querySelectorAll('*').length > 8;
        if (signature === previous && rendered) calmSince = calmSince || Date.now();
        else { previous = signature; calmSince = 0; }
        const waited = Date.now() - started;
        if (waited >= minimumDelay && calmSince && Date.now() - calmSince >= CALM_MS) return resolve();
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
    const listActions = () => discover().map(({ key, label, trigger, force, group }) => ({ key, label, trigger, force, group }));
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
  //
  // Three more things a screen revisited later differs by without being a different screen, each of
  // which cost a run whole duplicate states — an eight-minute capture came back with six copies of
  // its own home screen:
  //   · a relative timestamp ticks as the run goes ("2 phút" becomes "15 phút"), so digits collapse
  //   · a text box is only as wide as what it says, so a text run counts by what it says and which
  //     line it sits on, never by a width its own content decides
  // This one still answers a strict question — has the reused iframe returned to its baseline — where
  // a false "no" only costs a reload. Deciding whether two screens are the same screen is a different
  // question with a different answer; sameScreen below is the one that gets asked that.
  function sceneFingerprint(scene) {
    return JSON.stringify(scene.nodes.map(node => {
      const text = (node.text || '').replace(/\d+/g, '#');
      if (node.kind === 'text') return { kind: 'text', text, line: Math.round(node.y) };
      return {
        kind: node.kind,
        bounds: [node.x, node.y, node.width, node.height].map(value => Math.round(value)),
        text,
        fill: node.fill,
        stroke: node.stroke
      };
    }));
  }

  // Whether two captures are the same screen is a question about closeness, and an exact hash cannot
  // ask it: measured against a real run, revisiting a screen moved a bold-to-normal label by 1.25px
  // and shifted its neighbour by 0.1px, which was enough to keep six copies of one home screen.
  // Snapping to a grid made it worse rather than better — 300.9 and 301.1 are a fifth of a pixel
  // apart and land on opposite sides of every grid line. So compare with a tolerance instead.
  //
  // Geometry gets 2px of slack. Everything a designer would actually see a difference in — the
  // wording, the colours, the weight — has to match exactly, which is what keeps the selected tab
  // (heavier, greener, and 1.25px wider) a state of its own rather than a rounding error.
  const SAME_SCREEN_SLACK = 2;
  function screenDifference(one, two) {
    if (one.nodes.length !== two.nodes.length) return 'số node: ' + one.nodes.length + ' vs ' + two.nodes.length;
    const exact = node => JSON.stringify([
      node.kind, (node.text || '').replace(/\d+/g, '#'), node.fill, node.stroke, node.color,
      node.fontWeight, node.fontSize, node.opacity
    ]);
    for (let index = 0; index < one.nodes.length; index += 1) {
      const here = one.nodes[index];
      const there = two.nodes[index];
      const at = ' @' + (here.name || here.kind) + ' #' + index;
      if (exact(here) !== exact(there)) {
        const keys = ['kind', 'text', 'fill', 'stroke', 'color', 'fontWeight', 'fontSize', 'opacity'];
        const key = keys.find(name => JSON.stringify(here[name]) !== JSON.stringify(there[name])) || 'kiểu dáng';
        return key + ': ' + String(JSON.stringify(here[key])).slice(0, 24) + ' vs ' + String(JSON.stringify(there[key])).slice(0, 24) + at;
      }
      for (const key of ['x', 'y', 'width', 'height']) {
        if (Math.abs((here[key] || 0) - (there[key] || 0)) > SAME_SCREEN_SLACK) {
          return key + ': ' + Math.round(here[key]) + ' vs ' + Math.round(there[key]) + at;
        }
      }
    }
    return null;
  }

  // Every screen of a real app repeats its nav at the top of its DOM, so taking the first N actions in
  // document order spends a whole state's budget re-clicking what an earlier state already covered.
  // Measured on the POS page: 21 controls on the home screen, 8 clicked; open the menu and the same
  // nine nav items lead the list again while the drawer's own four controls sit at 22-25, so every
  // depth-1 state spent all eight of its clicks re-opening tabs and no run ever reached "Quản lý ca".
  //
  // So rank by what the run has not clicked yet, counting a control by its label with digits masked —
  // "Tất cả (12)" and "Tất cả (18)" are one control, and a badge that ticks must not make a tab look
  // new on every screen. It only re-orders: a repeat still gets clicked, and still links its state to
  // where it leads, whenever there is budget left after the new controls.
  // A whole number is one token, separators and all: masking digit runs alone leaves 420.000 as
  // ###.### and 1.240.000 as #.###.###, so two rows of the same list stop matching over a price.
  const actionSignature = action => (action.label || action.key || '')
    .toLowerCase().replace(/[\d.,]*\d[\d.,]*/g, '#').replace(/\s+/g, ' ').trim();
  const orderActions = (actions, tried) => actions
    .map((action, index) => ({ action, index, repeat: tried.has(actionSignature(action)) ? 1 : 0 }))
    .sort((one, two) => one.repeat - two.repeat || one.index - two.index)
    .map(item => item.action);

  // A control this run already clicked elsewhere almost always lands back on a screen already
  // captured — seven of the eight clicks in the logged run ended in a dedup — so it buys an edge, not
  // a screen, at a whole page load each. A state gets maxRepeatsPerState of them, enough to keep the
  // nav it shows linked, and spends the rest of its budget on what it alone offers. The ordering above
  // is what makes this safe to cut: everything past the cap is a repeat.
  //
  // The same signature also settles how many of a row of look-alike controls to click. Twelve table
  // cards produced twelve states that read identically in Figma — same layout, a different table
  // number — and one of them says everything the design needs. Grouping them by tag and class was
  // tried and reverted, because a tab strip is also one parent, one class, five siblings: three of
  // five tabs stopped being explored. The wording is what tells the two apart. A tab strip is five
  // different words and survives; a data list is one wording with the numbers moved, and collapses.
  // ponytail: one per wording. Tabs that differ only by a number ("Tầng 1" / "Tầng 2") collapse with
  // the data rows — put data-c2figma-force-explore on them to explore every one.
  const actionsToRun = (actions, tried, limits) => {
    const chosen = [];
    const seen = new Set();
    let repeats = 0;
    for (const action of orderActions(actions, tried)) {
      if (chosen.length >= limits.maxActionsPerState) break;
      const signature = actionSignature(action);
      if (!action.force && seen.has(signature)) continue;
      seen.add(signature);
      if (tried.has(signature) && (repeats += 1) > limits.maxRepeatsPerState) break;
      chosen.push(action);
    }
    return chosen;
  };

  // The wording cannot catch a menu grid: fifteen dish tiles are fifteen different words, and a run
  // clicked every one for fifteen states that differed only by which tile was highlighted. Structure
  // groups them, but structure alone was tried and reverted — a tab strip is also one component
  // repeated. The click is what separates them: a tab opens a screen of its own, while the next row
  // of a grid lands on a screen the run already has.
  //
  // So the proof is the verdict the capture came back with, not the shape of it. Counting three
  // siblings whose screens the run already had also survives a grid whose rows differ in size —
  // measured on an order's dish list, the sizes alternate 548/524/524/548 as tiles carry a quantity,
  // which defeated an earlier rule that wanted three of a size in a row. Of the six category tabs
  // beside that grid, exactly one landed on a screen the size of another, so a tab strip is nowhere
  // near the threshold.
  const REPEAT_PROOF = 3;
  const groupTracker = () => {
    const groups = new Map();
    const openable = action => action.group && !action.force;
    return {
      done: action => !!(openable(action) && (groups.get(action.group) || {}).done),
      saw: (action, familiar) => {
        if (!openable(action)) return false;
        const group = groups.get(action.group) || { familiar: 0, done: false };
        if (familiar) group.familiar += 1;
        group.done = group.familiar >= REPEAT_PROOF;
        groups.set(action.group, group);
        return group.done;
      }
    };
  };

  // maxActionsPerState has to clear a whole screen's controls or the ordering above only decides which
  // flows get dropped; 24 covers the pages measured. Depth is what a flow needs — a POS order is table
  // → order → item → action, and at 2 the run stopped before any of them finished. That leaves nothing
  // bounding the run, so maxPaths does it directly: one path is a page load plus its clicks, so 240 is
  // the ceiling on what a run costs. Breadth-first means the budget buys the shallow, widely-reachable
  // screens first.
  // ponytail: one flat budget, not a per-depth one. Raise maxPaths for a longer run.
  const LIMITS = { maxDepth: 4, maxActionsPerState: 24, maxRepeatsPerState: 4, maxPaths: 240 };

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
      const transitionKeys = new Set();
      // most paths dedupe into a state that already exists, so state count alone looks frozen for
      // long stretches; report attempted paths too.
      const progress = { attempted: 0, planned: 1 };
      const report = () => settings.onProgress && settings.onProgress({
        attempted: progress.attempted, planned: Math.min(progress.planned, settings.maxPaths), states: graph.states.length
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
        // Same node count first: it rules out almost every state for the price of one integer, and
        // the states that survive it are the only ones worth walking node by node.
        const sized = graph.states.filter(other => other.scene.nodes.length === result.scene.nodes.length);
        let state = sized.find(other => !screenDifference(result.scene, other.scene));
        const created = !state;
        if (!state) {
          state = { id: 'state-' + String(graph.states.length).padStart(2, '0'), label, actionPath, scene: result.scene };
          graph.states.push(state);
          if (onState) await onState(state, graph);
          // A state kept apart for a difference too small to see reads, line by line, exactly like a
          // real one — which is how a run kept six copies of one screen and looked correct doing it.
          // So whenever a state is kept next to one the same size, the log says what parted them.
          if (settings.onNotice && sized.length) {
            settings.onNotice({
              type: 'near-duplicate', state: state.id, twin: sized[0].id, nodes: result.scene.nodes.length,
              differsAt: screenDifference(result.scene, sized[0].scene) || 'không rõ'
            });
          }
        } else if (settings.onNotice) {
          settings.onNotice({ type: 'deduped', into: state.id, actionPath, label });
        }
        // familiar: this click landed on a screen the run already had, either exactly or near enough
        // that a same-sized twin exists. One of those is ordinary; three from one component is a grid.
        return { state, created, familiar: !created || sized.length > 0 };
      };
      const first = (await addState([], baseline, 'Default')).state;
      const enqueue = (queue, state, actions, depth) => {
        if (depth >= settings.maxDepth) return;
        progress.planned += Math.min(actions.length, settings.maxActionsPerState);
        queue.push({ state, actions, depth });
        report();
      };
      const queue = [];
      enqueue(queue, first, baseline.actions, 0);
      const expanded = new Set();
      const tried = new Set();
      while (queue.length && progress.attempted < settings.maxPaths) {
        const current = queue.shift();
        if (!current.state) continue;
        if (expanded.has(current.state.id)) continue;
        expanded.add(current.state.id);
        // per parent state: a grid that repeats on one screen says nothing about a grid on another
        const grids = groupTracker();
        for (const action of actionsToRun(current.actions, tried, settings)) {
          if (progress.attempted >= settings.maxPaths) break;
          if (grids.done(action)) continue;
          tried.add(actionSignature(action));
          const actionPath = current.state.actionPath.concat(action.key);
          const result = await attempt(actionPath);
          if (!result) continue;
          const destination = await addState(actionPath, result, action.label || action.key);
          if (grids.saw(action, destination.familiar) && settings.onNotice) {
            settings.onNotice({ type: 'group-repeats', from: current.state.id, label: action.label || action.key });
          }
          const transitionKey = [current.state.id, destination.state.id, action.key].join('|');
          if (!transitionKeys.has(transitionKey)) {
            transitionKeys.add(transitionKey);
            graph.transitions.push({ from: current.state.id, to: destination.state.id, actionKey: action.key, trigger: 'ON_CLICK' });
          }
          // Only a state this result created is enqueued with these actions. An action key carries the
          // element's place in its own state's list, so pairing one state's canonical path with another
          // path's keys asks for an action that path never had, and every child of it dies replaying.
          if (destination.created) enqueue(queue, destination.state, result.actions, current.depth + 1);
        }
      }
      // A run that stopped because it ran out of clicks looks exactly like one that explored everything.
      if (progress.attempted >= settings.maxPaths && settings.onNotice) {
        settings.onNotice({ type: 'budget-reached', attempted: progress.attempted, pending: queue.length });
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
  global.orderActionsFor = orderActions;
  global.actionsToRunFor = actionsToRun;
  global.groupTrackerFor = groupTracker;
  global.actionSignatureFor = actionSignature;
  global.captureModes = CAPTURE_MODES;
  global.defaultCaptureMode = DEFAULT_CAPTURE_MODE;
})(window);
