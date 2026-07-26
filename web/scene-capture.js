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

      const script = 'setTimeout(() => (' + serializeScene.toString() + ')(' + JSON.stringify(token) + ',' + settings.width + ',' + settings.height + '), 1200);';
      const probe = '<script>' + script + '<\/script>';
      iframe.srcdoc = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, probe + '</body>') : html + probe;
      timer = setTimeout(() => finish(reject, new Error('Không thể dựng layout HTML trong thời gian cho phép.')), settings.timeout);
    });
  }

  function serializeScene(token, width, height) {
    try {
      const ignored = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'TEMPLATE']);
      const parseColor = value => {
        if (!value || value === 'transparent') return null;
        const match = value.match(/rgba?\(([^)]+)\)/i);
        if (!match) return null;
        const parts = match[1].split(',').map(part => part.trim());
        const channel = part => Number(part.replace('%', '')) * (part.includes('%') ? 2.55 : 1);
        return { r: channel(parts[0]) / 255, g: channel(parts[1]) / 255, b: channel(parts[2]) / 255, a: parts[3] === undefined ? 1 : Number(parts[3]) };
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
        const borderWidth = Math.max(number(style.borderTopWidth), number(style.borderRightWidth), number(style.borderBottomWidth), number(style.borderLeftWidth));
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
          stroke: borderWidth ? parseColor(style.borderTopColor) : null,
          strokeWidth: borderWidth,
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
