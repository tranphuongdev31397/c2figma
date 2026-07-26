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
      const visible = (element, style, rect) => style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0 && rect.right >= 0 && rect.bottom >= 0 && rect.left <= width && rect.top <= height;
      const technical = element => element.id.startsWith('__bundler_') || element.closest('[id^="__bundler_"]');
      const payload = value => /(?:data:)?(?:text\/html|application\/json);base64,/i.test(value) || /^[A-Za-z0-9+/]{240,}={0,2}$/.test(value);
      const nodes = [];
      const ids = new Map();
      const elements = [...document.querySelectorAll('*')].filter(element => !ignored.has(element.tagName));

      for (const element of elements) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (!visible(element, style, rect) || technical(element) || nodes.length >= 2000) continue;
        const id = 'n' + nodes.length;
        ids.set(element, id);
        let parent = element.parentElement;
        while (parent && !ids.has(parent)) parent = parent.parentElement;
        const border = [
          { width: number(style.borderTopWidth), color: style.borderTopColor },
          { width: number(style.borderRightWidth), color: style.borderRightColor },
          { width: number(style.borderBottomWidth), color: style.borderBottomColor },
          { width: number(style.borderLeftWidth), color: style.borderLeftColor }
        ].reduce((best, side) => side.width >= best.width ? side : best, { width: 0, color: '' });
        const radius = Math.max(number(style.borderTopLeftRadius), number(style.borderTopRightRadius), number(style.borderBottomRightRadius), number(style.borderBottomLeftRadius));
        nodes.push({
          id,
          parentId: parent ? ids.get(parent) : null,
          kind: 'box',
          name: element.getAttribute('aria-label') || element.getAttribute('data-testid') || element.tagName.toLowerCase() + ' / ' + id,
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          fill: parseColor(style.backgroundColor),
          stroke: border.width ? parseColor(border.color) : null,
          strokeWidth: border.width,
          radius,
          opacity: Number(style.opacity) || 1,
          text: '',
          fontSize: number(style.fontSize),
          fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
          color: parseColor(style.color)
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
      }

      parent.postMessage({
        type: 'html-figma-scene',
        token,
        scene: { version: 1, viewport: { width, height }, nodes }
      }, '*');
    } catch (error) {
      parent.postMessage({ type: 'html-figma-scene-error', token, message: error.message }, '*');
    }
  }

  global.captureSceneGraph = captureSceneGraph;
})(window);
