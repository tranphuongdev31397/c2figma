const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../web/scene-capture.js'), 'utf8');

const load = () => {
  const scope = { window: {}, document: { createElement: () => ({}) } };
  scope.window.document = scope.document;
  vm.runInNewContext(source, scope);
  return scope.window;
};

test('gives a bundled page the same settle budget on both capture paths', () => {
  const { settleProfileFor } = load();
  const bundled = settleProfileFor('<div data-src="/__bundler/manifest.json"></div>');
  const plain = settleProfileFor('<p>hello</p>');

  assert.equal(bundled.bundled, true);
  assert.equal(plain.bundled, false);
  assert.ok(bundled.minimumDelay > plain.minimumDelay, 'a bundled page needs longer to hydrate');
  assert.ok(bundled.timeoutMs > bundled.minimumDelay, 'the capture must not time out before the page can settle');
  assert.ok(plain.timeoutMs > plain.minimumDelay);
});

// The floor was 3s for a bundled page and every path in a run pays it. Measured on the POS bundle,
// the app hydrates in 356ms — so an eight-second path spent most of its life asleep. A floor cannot
// know how long a page needs; a page that is still changing has to say so itself.
test('waits for the page to go quiet rather than sleeping a fixed floor', () => {
  const { settleProfileFor } = load();
  const bundled = settleProfileFor('<div data-src="/__bundler/manifest.json"></div>');

  assert.ok(bundled.minimumDelay <= 1000, 'a floor above a second is dead time on every path');
  assert.ok(bundled.calmMs >= 400, 'but the page has to hold still long enough to prove it hydrated');
  // the probe is serialized into the iframe, so its calm window is its own constant — and a profile
  // that no longer describes what the probe does is worse than no profile
  assert.equal(Number(source.match(/const CALM_MS = (\d+)/)[1]), bundled.calmMs);
  // a page mid-hydration must not read as quiet just because it is briefly empty and briefly still
  assert.match(source, /signature === previous && rendered/);
  // the post-click settle is a different budget and keeps its two looks: a dialog remounts a tick later
  assert.match(source, /while \(calm < 2 && Date\.now\(\) < deadline\)/);
});

test('waits for running animations to finish before capturing a state', () => {
  // ponytail: a fixed sleep captures a modal mid-fade, which both blurs the layer and
  // makes every replay of the same action fingerprint differently.
  assert.match(source, /getAnimations/);
  assert.match(source, /playState/);
  assert.doesNotMatch(source, /click\(\);\s*await sleep\(settleMs\);\s*\}/);
});

test('fingerprints a state by its structure, not by its animation frame', () => {
  const { sceneFingerprintFor } = load();
  const node = opacity => ({
    kind: 'frame', name: 'Modal', x: 10.4, y: 20.6, width: 100.2, height: 50,
    text: 'Thêm nhân viên mới', fill: { r: 1, g: 1, b: 1, a: 1 }, opacity
  });

  assert.equal(
    sceneFingerprintFor({ nodes: [node(0.4)] }),
    sceneFingerprintFor({ nodes: [node(1)] }),
    'the same modal caught mid-fade and fully open is one state'
  );
  assert.notEqual(
    sceneFingerprintFor({ nodes: [node(1)] }),
    sceneFingerprintFor({ nodes: [{ ...node(1), text: 'Sửa nhân viên' }] }),
    'different content is still a different state'
  );
});

// An 8-minute run kept six copies of its own home screen and four of one tab, because every revisit
// differed from the original by a fraction of a pixel: a label going from bold back to normal is
// 1.25px narrower and nudges its neighbour 0.1px. An exact hash cannot express "close enough", and
// snapping to a grid made it worse — 300.9 and 301.1 are a fifth of a pixel apart and land either
// side of every grid line. What must NOT be forgiven is anything a designer would see: the selected
// tab is heavier, greener and wider all at once, and stays a state of its own.
test('treats a screen revisited a pixel off as the same screen, but not a restyled one', () => {
  const source = fs.readFileSync(require.resolve('../web/scene-capture.js'), 'utf8');
  const body = source.match(/\n {2}function screenDifference\([\s\S]*?\n {2}\}\n/)[0];
  const scope = { JSON, Math, String, Number };
  vm.runInNewContext('const SAME_SCREEN_SLACK = 2;' + body + '\nglobalThis.diff = screenDifference;', scope);
  const node = overrides => ({
    kind: 'box', name: 'tab', text: 'Tất cả', x: 24.86, y: 10, width: 53.72, height: 32,
    fill: null, stroke: null, color: { r: 0, g: 0, b: 0, a: 1 }, fontWeight: 400, fontSize: 13, opacity: 1,
    ...overrides
  });
  const same = (one, two) => scope.diff({ nodes: [one] }, { nodes: [two] }) === null;

  assert.ok(same(node({ width: 53.72 }), node({ width: 52.47 })), 'a 1.25px reflow is the same screen');
  assert.ok(same(node({ x: 24.86 }), node({ x: 24.75 })), 'so is a tenth of a pixel');
  assert.ok(same(node({ text: '2 phút' }), node({ text: '15 phút' })), 'a timestamp that ticked mid-run is the same screen');
  assert.ok(!same(node({ fontWeight: 600, width: 53.72 }), node({ fontWeight: 400, width: 52.47 })),
    'the selected tab is heavier — that is a state, not a rounding error');
  assert.ok(!same(node({ color: { r: 0, g: 0.5, b: 0.2, a: 1 } }), node({ color: { r: 0, g: 0, b: 0, a: 1 } })),
    'and it is a different colour');
  assert.ok(!same(node({ fill: null }), node({ fill: { r: 0.9, g: 1, b: 0.9, a: 1 } })), 'a row that lit up is a state');
  assert.ok(!same(node({ text: 'Tất cả' }), node({ text: 'Hỗ trợ' })), 'different wording is a state');
  assert.ok(!same(node({ x: 24 }), node({ x: 44 })), 'a real 20px move is a state');
});

// The fingerprint answers a different, stricter question — has the reused iframe returned to its
// baseline — where a false "no" only costs a reload.
test('fingerprints a baseline without letting a ticking timestamp count as drift', () => {
  const { sceneFingerprintFor } = load();
  const screen = stamp => ({ nodes: [{ kind: 'text', x: 12, y: 20, width: stamp.length * 7, height: 16, text: stamp }] });

  assert.equal(sceneFingerprintFor(screen('2 phút')), sceneFingerprintFor(screen('15 phút')));
  assert.notEqual(sceneFingerprintFor(screen('2 phút')), sceneFingerprintFor(screen('Hôm qua')));
});

// A dialog fades in over ~200ms, and for the first frames its own opacity is exactly 0 while every
// child keeps opacity 1. Dropping just the faded element left its children behind, reparented onto the
// backdrop: the dialog's white sheet vanished and the page showed through its body.
const fakeDocument = (elements, animations = []) => {
  const styles = new Map();
  const rects = new Map();
  for (const element of elements) {
    element.childNodes = element.childNodes || [];
    element.getAttribute = name => element.attributes?.[name] ?? null;
    element.closest = () => null;
    element.id = element.attributes?.id || '';
    styles.set(element, {
      display: 'block', visibility: 'visible',
      // read late: an animation that lands changes it between getAnimations() and the style read
      get opacity() { return String(element.opacity ?? 1); },
      position: element.position || 'static', zIndex: 'auto', overflow: element.overflow || 'visible',
      overflowY: element.overflowY || 'visible', overflowX: element.overflowX || 'visible',
      backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)', fontSize: '14px', fontWeight: '400',
      borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      borderTopColor: 'rgb(0, 0, 0)', borderRightColor: 'rgb(0, 0, 0)', borderBottomColor: 'rgb(0, 0, 0)', borderLeftColor: 'rgb(0, 0, 0)',
      borderTopLeftRadius: '0px', borderTopRightRadius: '0px', borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px'
    });
    rects.set(element, element.rect || { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 });
    element.getBoundingClientRect = () => rects.get(element);
  }
  return {
    querySelectorAll: () => elements,
    getAnimations: () => animations,
    getComputedStyle: element => styles.get(element),
    // A text node that wraps reports one rect per visual line and one union box for the whole run —
    // the distinction the capture gets wrong is invisible unless the mock models both.
    createRange: () => {
      let target = null;
      const lines = () => (target && target.lineRects) || [];
      return {
        selectNodeContents(node) { target = node; },
        getClientRects: () => lines(),
        getBoundingClientRect: () => {
          const rects = lines();
          if (!rects.length) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
          const left = Math.min(...rects.map(rect => rect.left));
          const top = Math.min(...rects.map(rect => rect.top));
          const right = Math.max(...rects.map(rect => rect.right));
          const bottom = Math.max(...rects.map(rect => rect.bottom));
          return { left, top, right, bottom, width: right - left, height: bottom - top };
        }
      };
    }
  };
};

const runSerialize = (elements, animations) => {
  const body = source.match(/\n {2}function serializeScene\([\s\S]*?\n {2}\}\n/)[0];
  const dom = fakeDocument(elements, animations);
  const scope = {
    document: dom,
    getComputedStyle: dom.getComputedStyle,
    Set, Map, Math, Number, JSON, Error, String, Array
  };
  vm.runInNewContext(body + '\nresult = serializeScene("", 1440, 900);', scope);
  return scope.result;
};

test('drops the whole subtree of a layer faded to nothing, not just that layer', () => {
  const overlay = { tagName: 'DIV', attributes: { class: 'role-modal-overlay' }, parentElement: null, position: 'fixed' };
  const sheet = { tagName: 'DIV', attributes: { class: 'role-modal' }, parentElement: overlay, opacity: 0 };
  const head = { tagName: 'DIV', attributes: { class: 'rm-head' }, parentElement: sheet };
  const title = { tagName: 'SPAN', attributes: {}, parentElement: head };

  const names = runSerialize([overlay, sheet, head, title]).nodes.map(node => node.name);

  assert.ok(names.some(name => /role-modal-overlay/.test(name)), 'the backdrop is fully opaque and stays');
  assert.ok(!names.some(name => /rm-head/.test(name)), 'a child of a fully faded layer is invisible too');
  assert.ok(!names.some(name => /role-modal ·/.test(name)), 'the faded layer itself is still dropped');
  assert.equal(names.length, 1);
});

// A fixed-height list panel with its own scrollbar (overflow-y:auto) hid every row past its
// clientHeight from the capture — an invoice list showing 8 of 12 rows lost the last 4 to the fixed
// viewport bound, not to any dedup logic. Widening that bound captures them, but the frames must
// still be drawn exactly as measured: growing the panel to its scrollHeight and forcing
// overflow:visible bought a tall band of whitespace and threw away the clip that made the design
// read correctly. Capture more, draw the same — unchecking "Clip content" in Figma reveals the rest.
test('captures rows a scrollable panel clips without resizing or un-clipping it', () => {
  const panel = {
    tagName: 'DIV', attributes: { class: 'invoice-list' }, parentElement: null,
    overflowY: 'auto', overflow: 'auto', scrollHeight: 600, clientHeight: 200,
    rect: { left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 }
  };
  const belowFold = {
    tagName: 'DIV', attributes: { class: 'row-12' }, parentElement: panel,
    rect: { left: 0, top: 950, right: 100, bottom: 1000, width: 100, height: 50 }
  };

  const result = runSerialize([panel, belowFold]);
  const names = result.nodes.map(node => node.name);
  const panelNode = result.nodes.find(node => /invoice-list/.test(node.name));

  assert.ok(names.some(name => /row-12/.test(name)), 'a row past the 900px viewport cutoff is captured');
  assert.equal(result.viewport.width, 1440);
  assert.equal(result.viewport.height, 900,
    'the frame stays the real viewport — a taller one is just whitespace under the design');
  assert.equal(panelNode.height, 200, 'the panel keeps its measured height rather than growing to scrollHeight');
  assert.equal(panelNode.overflow, 'auto', 'the panel keeps clipping, so the captured rows hide until Clip content is unchecked');
});

// getClientRects() returns a rect per visual line, and a node per rect wrote the whole sentence once
// per line: a wrapped chat bubble arrived in Figma with its text stamped twice, each copy stretched
// onto a single line that spilled out of the bubble.
test('captures a wrapped text run once, with the line count the renderer needs', () => {
  const bubble = {
    tagName: 'DIV', attributes: { class: 'bubble' }, parentElement: null,
    rect: { left: 20, top: 20, right: 320, bottom: 76, width: 300, height: 56 },
    childNodes: [{
      nodeType: 3,
      data: 'Dạ chào Bích! Shop còn hàng ạ, có đủ màu đen, nâu và kem. Bạn thích màu nào?',
      lineRects: [
        { left: 32, top: 28, right: 308, bottom: 46, width: 276, height: 18 },
        { left: 32, top: 46, right: 190, bottom: 64, width: 158, height: 18 }
      ]
    }]
  };

  const texts = runSerialize([bubble]).nodes.filter(node => node.kind === 'text');

  assert.equal(texts.length, 1, 'one node per run — a node per line stamped the sentence twice');
  assert.equal(texts[0].lines, 2, 'the renderer has to know the page wrapped this run');
  assert.equal(Math.round(texts[0].width), 276, 'the box spans the width the run wrapped inside');
  assert.equal(Math.round(texts[0].height), 36, 'and the height of both its lines');
});

test('re-checks for animations that only start after the first look', () => {
  // the dialog remounts on a later tick, so one getAnimations() call can find a calm page and
  // serialize straight into the next fade.
  assert.match(source, /calm/);
  assert.doesNotMatch(source, /await sleep\(settleMs\);\s*await waitForAnimations\(\);\s*await sleep\(settleMs\);\s*\}/);
});

test('ends every running animation before reading the page', () => {
  // Out-waiting a fade is a race the capture keeps losing. These are Web Animations, so no injected
  // stylesheet reaches them — the probe has to end them itself.
  const overlay = { tagName: 'DIV', attributes: { class: 'role-modal-overlay' }, parentElement: null, position: 'fixed' };
  const sheet = { tagName: 'DIV', attributes: { class: 'role-modal' }, parentElement: overlay, opacity: 0 };
  const finished = [];
  const animations = [
    { name: 'fade', finish() { finished.push('fade'); sheet.opacity = 1; } },
    { name: 'spinner', finish() { finished.push('spinner'); throw new Error('Cannot finish Animation with an infinite target effect'); } }
  ];

  const names = runSerialize([overlay, sheet], animations).nodes.map(node => node.name);

  assert.deepEqual(finished, ['fade', 'spinner'], 'every animation is asked to land');
  assert.ok(names.some(name => /role-modal ·/.test(name)), 'the dialog that finished its fade is captured whole');
});

test('caps how long one action may wait to settle', () => {
  // an unbounded re-check spent 12s per action and blew the per-path budget, so every path that
  // opened something animated timed out and its state never existed.
  const { settleProfileFor } = load();
  const budget = source.match(/const SETTLE_BUDGET_MS = (\d+)/);

  assert.ok(budget, 'the settle needs a stated ceiling');
  const perAction = Number(budget[1]);
  assert.ok(perAction <= 2000, 'a single action must not eat seconds');
  // the deepest path plus hydration still has to fit inside the path timeout — a run that explores
  // four clicks deep times every one of them out otherwise, which is how animated states stopped existing
  const profile = settleProfileFor('<div data-src="/__bundler/manifest.json"></div>');
  const { explorationLimits } = load();
  assert.ok(profile.minimumDelay + profile.calmMs + perAction * explorationLimits.maxDepth < profile.timeoutMs,
    'settling must fit the path budget at full depth');
  assert.match(source, /SETTLE_BUDGET_MS/);
});

test('bounds exploration by depth rather than by a state count', () => {
  const { explorationLimits } = load();

  // a state cap discards states the run already paid for without shortening the run
  assert.equal(explorationLimits.maxStates, undefined);
  assert.ok(explorationLimits.maxDepth >= 4, 'two clicks deep stops before most flows begin');
  // measured: the POS home screen offers 21 controls and every screen behind it 25, so a cap of 8
  // could not reach a screen's own content however the list was ordered
  assert.ok(explorationLimits.maxActionsPerState >= 24);
  // depth alone no longer bounds the run, so the run needs its own ceiling
  assert.ok(explorationLimits.maxPaths > 0);
});

// Measured on the POS page: 21 controls on the home screen, 8 clicked. Opening the menu offers 25,
// and the first nine are the same nav items depth 0 already clicked — the drawer's own four controls
// sit at 22-25, so every depth-1 state spent all eight of its clicks re-opening the same tabs and no
// run ever opened "Quản lý ca". Rank by what the run has not clicked yet, so a cap that bites drops a
// repeat instead of a flow.
test('spends the click budget on controls the run has not clicked yet', () => {
  const { orderActionsFor, actionSignatureFor } = load();
  const control = label => ({ key: 'action-' + label.toLowerCase().replace(/\W+/g, '-'), label });
  const nav = ['Menu', 'Đơn hàng 18', 'Sơ đồ bàn 6', 'Trả món 10', 'Phiếu tạm tính 3', 'Tất cả (12)'].map(control);
  const tables = ['Bàn 01', 'Bàn 02', 'Bàn 03'].map(control);
  const drawer = ['Đóng menu', 'Quản lý ca', 'Cài đặt', 'Đổi cửa hàng / đăng xuất'].map(control);
  const tried = new Set();
  const spend = (actions, budget) => orderActionsFor(actions, tried).slice(0, budget)
    .map(action => { tried.add(actionSignatureFor(action)); return action.label; });

  // depth 0 sees the home screen and can afford six of its nine controls
  assert.deepEqual(spend([...nav, ...tables], 6), nav.map(action => action.label));
  // depth 1 opens the menu: nav leads its DOM order again, the drawer trails it
  const next = spend([...nav, ...tables, ...drawer], 6);
  assert.deepEqual(next, [...tables, ...drawer].slice(0, 6).map(action => action.label),
    'the controls this screen added come before the nav the run already clicked');
  assert.equal(next.filter(label => nav.some(action => action.label === label)).length, 0);

  // a counter in the label is the same control either way, or every revisit looks new
  assert.equal(actionSignatureFor(control('Tất cả (12)')), actionSignatureFor(control('Tất cả (18)')));
  assert.notEqual(actionSignatureFor(control('Tất cả (12)')), actionSignatureFor(control('Tầng 1 (6)')));
  // and a price is one number however many separators it carries, or two rows of one list part over it
  assert.equal(actionSignatureFor(control('Bàn 01 420.000 5 món')), actionSignatureFor(control('Bàn 11 1.240.000 12 món')));
  assert.notEqual(actionSignatureFor(control('Bàn 01 420.000 5 món')), actionSignatureFor(control('Bàn 02 Còn trống')));
});

// Clicking the nav again from a screen that already has it lands on a screen the run captured long
// ago — seven of the eight clicks in the logged run ended in a dedup. It buys an edge, not a screen,
// at a full page load each, so a state gets a few of them and spends the rest on what it alone offers.
test('rations the clicks that only lead back to screens already captured', () => {
  const { actionsToRunFor, actionSignatureFor, explorationLimits } = load();
  const control = label => ({ key: 'action-' + label, label });
  const nav = ['Menu', 'Đơn hàng', 'Sơ đồ bàn', 'Trả món', 'Phiếu tạm tính', 'QN Quán', 'Tất cả', 'Tầng 1', 'Tầng 2'].map(control);
  const own = ['Đóng menu', 'Quản lý ca', 'Cài đặt'].map(control);
  const tried = new Set(nav.map(actionSignatureFor));

  // spread it: the helper builds its list inside the vm realm, and deepEqual compares prototypes
  const run = [...actionsToRunFor([...nav, ...own], tried, explorationLimits)].map(action => action.label);
  assert.deepEqual(run.slice(0, 3), own.map(action => action.label), 'this screen’s own controls come first');
  assert.equal(run.length, own.length + explorationLimits.maxRepeatsPerState);
  assert.ok(explorationLimits.maxRepeatsPerState >= 1, 'a screen still links back to the nav it shows');

  // nothing tried yet: the cap must not bite what has never been clicked ("Tầng 1"/"Tầng 2" are one
  // wording, and collapse for that reason rather than this one)
  const distinct = new Set([...nav, ...own].map(actionSignatureFor)).size;
  assert.equal([...actionsToRunFor([...nav, ...own], new Set(), explorationLimits)].length, distinct);
});

// Twelve table cards on one screen produced twelve states that read identically in Figma — same
// layout, a different table number. An earlier attempt grouped look-alike controls by tag and class
// and had to be reverted: a tab strip is also one parent, one class, five siblings, so three of five
// tabs stopped being explored. Wording tells them apart where structure cannot — tabs are five
// different words, a data list is one wording with different numbers in it.
test('clicks one of a row of look-alike controls, not all twelve', () => {
  const { actionsToRunFor, explorationLimits } = load();
  const control = label => ({ key: 'action-' + label, label });
  const tabs = ['Tất cả', 'Cơm', 'Phở & Bún', 'Đồ uống', 'Bánh'].map(control);
  const tables = ['Bàn 01 420.000 52 phút · 5 món', 'Bàn 02 Còn trống', 'Bàn 03 185.000 24 phút · 3 món',
    'Bàn 04 Còn trống', 'Bàn 05 468.000 40 phút · 9 món', 'Bàn 11 1.240.000 69 phút · 12 món'].map(control);
  const run = [...actionsToRunFor([...tabs, ...tables], new Set(), explorationLimits)].map(action => action.label);

  assert.deepEqual(run.slice(0, tabs.length), tabs.map(action => action.label), 'every tab is its own screen');
  // an occupied table and a free one are different screens; a second occupied table is not
  assert.deepEqual(run.slice(tabs.length), ['Bàn 01 420.000 52 phút · 5 món', 'Bàn 02 Còn trống']);

  // the escape hatch CLAUDE.md promises has to actually escape
  const forced = tables.map(action => ({ ...action, force: true }));
  assert.equal([...actionsToRunFor(forced, new Set(), explorationLimits)].length, tables.length);
  assert.match(source, /data-c2figma-force-explore/);
});

// The wording cannot catch a menu grid: fifteen dish tiles are fifteen different words, and a run
// clicked every one for fifteen states that differed only by which tile was highlighted. Only the
// click tells a data grid from a tab strip — both are one parent and one class, but a tab opens a
// screen of its own size while the next row opens the same screen with other numbers in it.
test('stops working through a grid once the clicks prove it repeats', () => {
  const { groupTrackerFor } = load();
  const member = (group, index) => ({ key: group + index, label: group + ' ' + index, group });
  // walk a group, deciding each click's fate with the verdict the capture came back with
  const walk = (group, verdicts) => {
    const tracker = groupTrackerFor();
    const clicked = [];
    verdicts.forEach((familiar, index) => {
      const action = member(group, index);
      if (tracker.done(action)) return;
      clicked.push(index);
      tracker.saw(action, familiar);
    });
    return clicked;
  };

  // fifteen dish tiles: the first opens a screen of its own, every one after it lands on a screen
  // the run already has. The sizes alternate (548/524/524/548…) as tiles carry a quantity, so what
  // counts is the verdict, not the size.
  assert.deepEqual(walk('grid', Array(15).fill(true).fill(false, 0, 1)), [0, 1, 2, 3],
    'three familiar screens is proof; the other eleven are not worth a page load');

  // the six category tabs measured beside them: only "Bánh" landed on a screen the size of another
  assert.deepEqual(walk('bar', [false, false, false, true, false, false]), [0, 1, 2, 3, 4, 5],
    'a tab strip opens a screen of its own each time and survives');

  // the escape hatch outranks the proof
  const forced = groupTrackerFor();
  const stubborn = { ...member('grid', 0), force: true };
  for (let index = 0; index < 5; index += 1) forced.saw(stubborn, true);
  assert.equal(forced.done(stubborn), false);
});

// The settings screen renders each row in its own wrapper, so grouping by the parent element gave
// seventeen groups of one and the proof above never ran: eleven near-identical states came back from
// one list. The chain of tags and classes is what those rows share.
test('groups look-alike controls that do not share a parent element', () => {
  assert.match(source, /const groupFor/);
  assert.doesNotMatch(source, /groupIds/, 'parent identity groups a wrapped row with nothing');
  // element, parent and grandparent, so a row wrapped one deep still matches its siblings
  assert.match(source, /parentElement/);
});

// A run that stops because it ran out of budget looks exactly like a run that explored everything,
// which is how a capture missing most of its flows read as complete.
test('says so when the click budget, not the app, ended the run', () => {
  assert.match(source, /budget-reached/);
  assert.match(source, /maxPaths/);
});

test('offers a reused-iframe mode without making it the default', () => {
  const { captureModes, defaultCaptureMode } = load();

  assert.deepEqual(Object.keys(captureModes).sort(), ['fresh', 'reuse']);
  assert.equal(defaultCaptureMode, 'fresh', 'a fresh iframe per path stays the trusted baseline');
  // reuse trades isolation for speed, so it has to prove it got back to the baseline
  assert.match(source, /resetToBaseline/);
  assert.match(source, /html-figma-ready/);
  assert.match(source, /reuse-degraded/);
});

test('finds a dialog to dismiss by shape, not by the class it may not have', () => {
  // the sheet in the real page is inline-styled divs: no class, no aria-label, and Escape does nothing.
  // Only a viewport-sized positioned layer identifies the backdrop that closes it.
  assert.match(source, /dismissers/);
  assert.match(source, /innerWidth \* 0\.9/);
  assert.match(source, /position === 'fixed' \|\| position === 'absolute'/);
  assert.match(source, /document\.activeElement \|\| document\.body/);
});

test('reloads the reused iframe instead of capturing a leftover modal', () => {
  // a path replayed on top of the previous path's modal is not that path, so its state is worthless
  assert.match(source, /const boot = /);
  assert.match(source, /await boot\(\);\s*\n\s*const retry = await send\(actionPath\)/);
  // and a reload that still cannot reach the baseline must fail the path rather than pass off a leftover
  assert.match(source, /if \(retry\.degraded\) throw/);
});

test('captures z-index so the renderer can rebuild stacking order', () => {
  assert.match(source, /zIndex: style\.zIndex/);
});

test('both probes serialize into valid injectable scripts', () => {
  // the probes reach the iframe as source text, so a syntax slip only shows up at run time
  const scope = { window: {}, document: { createElement: () => ({ setAttribute() {}, style: {} }) } };
  scope.window.document = scope.document;
  vm.runInNewContext(source, scope);

  const injected = [...new Set([...source.matchAll(/\+ (\w+)\.toString\(\)/g)].map(match => match[1]))];
  assert.deepEqual(injected.sort(), [
    'actionKeyFor', 'captureInteractivePath', 'captureWhenStable',
    'interactionToolkit', 'reusableProbe', 'sceneFingerprint', 'serializeScene'
  ]);

  for (const probe of injected) {
    const body = source.match(new RegExp('\\n  function ' + probe + '\\([\\s\\S]*?\\n  \\}\\n'));
    assert.ok(body, probe + ' must be a top-level function so toString() carries it whole');
    assert.doesNotThrow(() => new vm.Script('(function(){' + body[0] + '})'), probe + ' is not valid JavaScript');
  }
});

test('reports attempted paths, not only discovered states', () => {
  // most paths dedupe away, so a states-only counter sits still while the run is busy
  assert.match(source, /onProgress/);
  assert.match(source, /attempted/);
  assert.match(source, /planned/);
});

test('the interactive path waits for the same profile as the static path', () => {
  assert.match(source, /settleProfileFor\(html\)/);
  assert.match(source, /minimumDelay/);
  assert.doesNotMatch(source, /stateTimeoutMs: 1500/);
});

test('waits for the rendered DOM to settle before serializing a bundled page', () => {
  assert.match(source, /captureWhenStable/);
  assert.match(source, /stableTicks/);
  assert.match(source, /__bundler.*manifest/);
  assert.match(source, /borderBottomColor/);
});

test('captures native control text and SVG artwork as real scene layers', () => {
  assert.match(source, /element\.placeholder/);
  assert.match(source, /kind: isSvg \? 'svg'/);
  assert.match(source, /outerHTML/);
});

test('recognizes SVG roots regardless of HTML tag-name casing', () => {
  assert.match(source, /element\.tagName\.toLowerCase\(\) === 'svg'/);
});

test('preserves positioned layers for renderer stacking', () => {
  assert.match(source, /position: style\.position/);
});

test('captures CSS overflow so Figma does not over-clip text', () => {
  assert.match(source, /style\.overflow/);
});

test('names element layers with stable semantic names and indexes', () => {
  assert.match(source, /nameForElement/);
  assert.match(source, /nameIndex/);
  assert.match(source, /padStart\(2, '0'\)/);
});

test('captures border widths per side instead of flattening them', () => {
  assert.match(source, /top: \{ width: number\(style\.borderTopWidth\)/);
  assert.match(source, /bottom: \{ width: number\(style\.borderBottomWidth\)/);
});

test('exposes the bounded interactive state graph contract', () => {
  assert.match(source, /captureStateGraph/);
  assert.match(source, /onState/);
  assert.match(source, /actionKey/);
  assert.match(source, /transitions/);
  assert.match(source, /data-c2figma-action-key/);
  assert.match(source, /maxActionsPerState/);
  assert.match(source, /screenDifference/);
});

// Discovery is what stamps data-c2figma-action-key onto the elements. Serializing before it ran left
// the scene carrying the tags of the previous state — or, on the baseline, none at all — so the
// renderer could not find the layer a transition starts from and dropped the link.
const runProbe = (name, call, scope) => {
  const body = source.match(new RegExp('\\n {2}function ' + name + '\\([\\s\\S]*?\\n {2}\\}\\n'))[0];
  vm.runInNewContext(body + '\n' + call + ';', scope);
};

const probeScope = calls => ({
  setTimeout, Promise, Error, JSON, Map, Set, Date,
  parent: { postMessage(message) { calls.push('post:' + (message.actions || []).length); } },
  window: { addEventListener() {} },
  toolkit: () => ({
    waitForStable: async () => {},
    replay: async () => {},
    settleAfterAction: async () => {},
    listActions: () => { calls.push('tag'); return [{ key: 'a1', label: 'x', trigger: 'ON_CLICK' }]; }
  }),
  actionKeyFor: () => 'a1',
  serialize: () => { calls.push('serialize'); return { nodes: [] }; },
  fingerprint: () => 'fp'
});

test('tags the state it is about to serialize, not the one before it', async () => {
  const calls = [];
  const scope = probeScope(calls);
  runProbe('captureInteractivePath', "captureInteractivePath(toolkit, actionKeyFor, serialize, 'tok', 100, 100, 0, [], 0)", scope);
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.deepEqual(calls, ['tag', 'serialize', 'post:1'],
    'discovery stamps the action keys, so it has to run before the scene is read');
});

// Action keys carry the element's position in the discovered list, so a leftover dropdown shifts
// every key after it and the replay asks for one that no longer exists. Replaying on a page that is
// not back at the baseline cannot produce that path's state, whatever it produces instead.
const reuseScope = calls => {
  const scope = probeScope(calls);
  let dirty = true;
  const element = { click() { calls.push('dismiss'); }, getBoundingClientRect: () => ({ width: 1440, height: 900 }), dispatchEvent() {}, blur() {} };
  scope.innerWidth = 1440;
  scope.innerHeight = 900;
  scope.KeyboardEvent = function () {};
  scope.getComputedStyle = () => ({ position: 'fixed', display: 'block', visibility: 'visible', opacity: '1' });
  scope.document = {
    body: { querySelectorAll: () => [element] },
    querySelectorAll: () => [],
    activeElement: element,
    dispatchEvent() {}
  };
  scope.window = { addEventListener: (name, handler) => { if (name === 'message') scope.handler = handler; } };
  scope.toolkit = () => ({
    waitForStable: async () => {},
    settleAfterAction: async () => {},
    visible: () => true,
    replay: async () => { calls.push('replay'); },
    listActions: () => { calls.push('tag'); return []; }
  });
  // the baseline is taken at boot, then the page stays dirty however often it is asked to reset
  scope.fingerprint = () => (dirty === true ? 'baseline' : 'leftover');
  scope.markDirty = () => { dirty = 'left over'; };
  return scope;
};

test('does not replay a path on a page that never got back to the baseline', async () => {
  const calls = [];
  const scope = reuseScope(calls);
  runProbe('reusableProbe', "reusableProbe(toolkit, actionKeyFor, serialize, fingerprint, 'tok', 100, 100, 0, 0)", scope);
  await new Promise(resolve => setTimeout(resolve, 20));

  scope.markDirty();
  calls.length = 0;
  await scope.handler({ data: { token: 'tok', type: 'run-path', requestId: 1, actionPath: ['a1'] } });

  assert.ok(!calls.includes('replay'), 'a dirty page cannot produce the state this path asked for');
  assert.ok(calls.some(call => /^post:/.test(call)), 'the runner still gets an answer, so it can reload and retry');
});

test('replays actions by stable key instead of candidate index', () => {
  assert.match(source, /actionKeyFor/);
  assert.match(source, /find\(.*\.key.*actionPath/);
  assert.doesNotMatch(source, /candidates\[actionPath\[/);
});

test('filters decorative candidates from action discovery', () => {
  assert.match(source, /aria-hidden.*true/);
  assert.match(source, /role.*presentation.*none/);
});

// Collapsing repeated siblings by tag+class to dodge duplicate states cost real coverage instead: a
// tab strip is five buttons that share a parent, a tag and a class and differ only by which one
// carries `active`, so four of the five tabs — four distinct screens — stopped being explored at all.
// Structure cannot tell a repeated data row from a tab; discovery must keep every sibling.
test('keeps every sibling action, including tabs that differ only by a state class', () => {
  const body = source.match(/\n {2}function interactionToolkit\([\s\S]*?\n {2}\}\n/)[0]
    + source.match(/\n {2}function actionKeyFor\([\s\S]*?\n {2}\}\n/)[0];
  const strip = { tagName: 'DIV' };
  const tab = (label, className) => ({
    tagName: 'BUTTON', className, parentElement: strip, disabled: false, textContent: label,
    getAttribute: () => null, setAttribute() {},
    getBoundingClientRect: () => ({ width: 80, height: 32, right: 80, bottom: 32 })
  });
  const tabs = [tab('Tất cả', 'tab active'), tab('Hỗ trợ', 'tab'), tab('Trợ lý', 'tab'), tab('Hệ thống', 'tab'), tab('Đơn hàng', 'tab')];
  const scope = {
    document: { querySelectorAll: () => tabs },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    Set, Map
  };
  vm.runInNewContext(body + '\nresult = interactionToolkit(actionKeyFor, 0, 0).discover();', scope);

  assert.deepEqual([...scope.result].map(action => action.label),
    ['Tất cả', 'Hỗ trợ', 'Trợ lý', 'Hệ thống', 'Đơn hàng'],
    'every tab is its own screen, however alike the markup looks');
});

test('filters external navigation schemes while allowing hash links', () => {
  assert.match(source, /https\?\|ftp\|data\|javascript\|mailto\|tel/);
  assert.match(source, /test\(element\.href\)/);
  assert.doesNotMatch(source, /href.*#.*external/);
});

test('preserves same-document hash links before resolving the URL', () => {
  assert.match(source, /const href = element\.getAttribute\('href'\) \|\| ''/);
  assert.match(source, /!href\.startsWith\('#'\)/);
});
