import assert from 'node:assert/strict';
import test from 'node:test';
import { placePopover, placeSheet, POPOVER_EDGE, POPOVER_GAP, SHEET_TOP_RESERVE, wantsSheet, type AnchorBox, type PopoverPosition } from './popover-placement';

/**
 * The panel the bell and the quota rings open, wherever their widget stands:
 * under an icon of the top bar, next to one in a sidebar, on a 360px phone.
 * What must always hold: the whole panel is inside the window, and its height
 * ceiling is the room actually left on its side.
 */
const box = (left: number, top: number, size = 36): AnchorBox => ({ left, top, right: left + size, bottom: top + size });

function inside(pos: PopoverPosition, vw: number, vh: number) {
  assert.ok(pos.left >= POPOVER_EDGE, `left ${pos.left}`);
  assert.ok(pos.left + pos.width <= vw - POPOVER_EDGE, `right edge ${pos.left + pos.width} > ${vw - POPOVER_EDGE}`);
  const top = pos.top ?? vh - (pos.bottom ?? 0) - pos.maxHeight;
  assert.ok(top >= POPOVER_EDGE - 0.5, `top ${top}`);
  assert.ok(top + pos.maxHeight <= vh - POPOVER_EDGE + 0.5, `bottom ${top + pos.maxHeight}`);
}

test('under an icon of the top bar: below, right edges aligned, height capped', () => {
  const pos = placePopover(box(1200, 6), { width: 1280, height: 800 }, { placement: 'below', width: 352, maxHeight: 512 });
  assert.equal(pos.side, 'below');
  assert.equal(pos.left + pos.width, 1236);
  assert.equal(pos.top, 48);
  assert.equal(pos.maxHeight, 512);
  inside(pos, 1280, 800);
});

test('on a 360px phone the panel takes the window minus its margins, clamped', () => {
  const pos = placePopover(box(240, 6), { width: 360, height: 640 }, { placement: 'below', width: 352 });
  assert.equal(pos.width, 360 - 2 * POPOVER_EDGE);
  assert.equal(pos.left, POPOVER_EDGE);
  inside(pos, 360, 640);
});

test('next to an icon of the left rail: to its right, level with it', () => {
  const pos = placePopover(box(10, 200), { width: 1280, height: 800 }, { placement: 'beside', width: 352, maxHeight: 512 });
  assert.equal(pos.side, 'right');
  assert.equal(pos.left, 52);
  assert.equal(pos.top, 200);
  inside(pos, 1280, 800);
});

test('at the foot of the rail it grows upward instead of into the last 80px', () => {
  const pos = placePopover(box(10, 720), { width: 1280, height: 800 }, { placement: 'beside', width: 352, maxHeight: 512 });
  assert.equal(pos.side, 'right');
  assert.equal(pos.top, undefined);
  assert.equal(pos.bottom, 800 - 756);
  assert.equal(pos.maxHeight, 512);
  inside(pos, 1280, 800);
});

test('in the right sidebar it opens to the left', () => {
  const pos = placePopover(box(1230, 300), { width: 1280, height: 800 }, { placement: 'beside', width: 352 });
  assert.equal(pos.side, 'left');
  assert.equal(pos.left + pos.width, 1224);
  inside(pos, 1280, 800);
});

test('beside on a phone, where no side has room: below, still on screen', () => {
  const pos = placePopover(box(10, 100), { width: 360, height: 640 }, { placement: 'beside', width: 352 });
  assert.equal(pos.side, 'below');
  inside(pos, 360, 640);
});

test('an anchor near the bottom of a short window flips the panel above it', () => {
  const pos = placePopover(box(600, 560), { width: 1280, height: 640 }, { placement: 'below', width: 352, maxHeight: 512 });
  assert.equal(pos.side, 'above');
  assert.equal(pos.bottom, 640 - 560 + 6);
  assert.equal(pos.maxHeight, 512);
  inside(pos, 1280, 640);
});

test('the height ceiling is the room left when smaller than the cap', () => {
  const pos = placePopover(box(600, 6), { width: 1280, height: 400 }, { placement: 'below', width: 352, maxHeight: 512 });
  assert.equal(pos.maxHeight, 400 - 42 - 6 - POPOVER_EDGE);
  inside(pos, 1280, 400);
});

/** Mounted: the panel the component paints follows the placement, and the
 *  keyboard and pointer close it the way a dropdown should. */
test('the popover stays in a 360px window, closes on Escape and on a press outside', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<button id="anchor">a</button><p id="out">x</p><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(dom.window, 'innerWidth', { value: 360, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: 640, configurable: true });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AnchoredPopover } = await import('../components/anchored-popover');
  const anchor = dom.window.document.getElementById('anchor')!;
  // A bell at the right of a phone's top bar.
  anchor.getBoundingClientRect = () => ({ left: 300, top: 6, right: 336, bottom: 42, width: 36, height: 36, x: 300, y: 6, toJSON: () => ({}) });
  const closes: string[] = [];
  const root = createRoot(dom.window.document.getElementById('root')!);
  const render = (open: boolean) => root.render(React.createElement(AnchoredPopover, {
    open, onClose: () => closes.push('close'), anchorRef: { current: anchor }, label: 'Panel', width: 352,
  }, React.createElement('p', null, 'body')));
  try {
    await React.act(async () => { render(false); });
    assert.ok(!document.querySelector('[role="dialog"]'), 'closed: nothing painted');

    await React.act(async () => { render(true); });
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(panel);
    assert.equal(panel.getAttribute('aria-label'), 'Panel');
    const left = parseFloat(panel.style.left);
    const width = parseFloat(panel.style.width);
    assert.ok(left >= POPOVER_EDGE && left + width <= 360 - POPOVER_EDGE, `panel ${left}+${width} inside 360px`);
    assert.equal(panel.style.top, '48px');
    assert.equal(panel.style.maxHeight, '512px');

    // A press on the anchor is the anchor's own toggle, not "outside".
    await React.act(async () => { anchor.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })); });
    await React.act(async () => { panel.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })); });
    assert.deepEqual(closes, []);
    await React.act(async () => { document.getElementById('out')!.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })); });
    assert.deepEqual(closes, ['close']);

    await React.act(async () => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.deepEqual(closes, ['close', 'close']);
    assert.equal(document.activeElement, anchor, 'Escape gives the focus back to the anchor');
  } finally {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test('a chip with some room under it but not the panel\'s height opens above, where the room is', () => {
  // 170px under the composer chip, 560 above it: below would squeeze the picker to a strip.
  const pos = placePopover(box(300, 560), { width: 1280, height: 776 }, { placement: 'below', align: 'start', width: 320, maxHeight: 360 });
  assert.equal(pos.side, 'above');
  assert.equal(pos.maxHeight, 360);
  inside(pos, 1280, 776);
});

test('align start: a chip at the foot of the composer opens above, left edges aligned', () => {
  const pos = placePopover(box(300, 740), { width: 1280, height: 800 }, { placement: 'below', align: 'start', width: 420, maxHeight: 484 });
  assert.equal(pos.side, 'above');
  assert.equal(pos.left, 300);
  assert.equal(pos.bottom, 800 - 740 + 6);
  inside(pos, 1280, 800);
  // Too close to the right edge, the clamp still keeps it on screen.
  const clamped = placePopover(box(1100, 740), { width: 1280, height: 800 }, { placement: 'below', align: 'start', width: 420 });
  assert.equal(clamped.left + clamped.width, 1280 - POPOVER_EDGE);
});

/**
 * A phone with its soft keyboard open: the visual viewport is 390×360 out of
 * a 390×844 window, and the page has scrolled 250px under it (iOS keeps the
 * layout viewport, Android shrinks it — both report the visual one). The
 * anchor comes in layout coordinates, the position in the visible area's.
 */
const KEYBOARD = { width: 390, height: 360, top: 250, left: 0 };

test('keyboard open: a chip at the foot of the visible area opens above it, inside the visible band', () => {
  // The chip sits 40px above the keyboard: layout y 570, visible y 320.
  const pos = placePopover(box(16, 570, 32), KEYBOARD, { placement: 'below', align: 'start', width: 420, maxHeight: 484 });
  assert.equal(pos.side, 'above');
  // The panel's foot is GAP above the chip, measured from the visible bottom, not the window's.
  assert.equal(pos.bottom, 360 - 320 + POPOVER_GAP);
  assert.equal(pos.maxHeight, 320 - POPOVER_GAP - POPOVER_EDGE);
  inside(pos, 390, 360);
});

test('keyboard open: the window height no longer decides the side', () => {
  // Without the visual viewport the same chip has the whole panel's room under
  // it in a 1200px window and opens below — behind the keyboard.
  const blind = placePopover(box(16, 570, 32), { width: 390, height: 1200 }, { placement: 'below', align: 'start', width: 420, maxHeight: 484 });
  assert.equal(blind.side, 'below');
  const seen = placePopover(box(16, 570, 32), KEYBOARD, { placement: 'below', align: 'start', width: 420, maxHeight: 484 });
  assert.equal(seen.side, 'above');
});

test('a visual viewport scrolled sideways (pinch zoom) shifts the anchor, not the clamp', () => {
  const pos = placePopover(box(300, 100), { width: 200, height: 400, top: 0, left: 150 }, { placement: 'below', width: 352 });
  assert.equal(pos.side, 'below');
  assert.equal(pos.top, 136 + POPOVER_GAP);
  inside(pos, 200, 400);
});

test('a sheet spans the foot of the visible area, keyboard open or not', () => {
  const closed = placeSheet({ width: 390, height: 844 }, { maxHeight: 484 });
  assert.equal(closed.side, 'sheet');
  assert.equal(closed.left, POPOVER_EDGE);
  assert.equal(closed.width, 390 - 2 * POPOVER_EDGE);
  assert.equal(closed.bottom, POPOVER_EDGE);
  assert.equal(closed.maxHeight, 484);
  inside(closed, 390, 844);

  // Keyboard open: same foot (now the keyboard's top), the ceiling is the room
  // left minus a band to tap outside — the keyboard has no Escape.
  const open = placeSheet(KEYBOARD, { maxHeight: 484 });
  assert.equal(open.bottom, POPOVER_EDGE);
  assert.equal(open.left, closed.left);
  assert.equal(open.maxHeight, 360 - POPOVER_EDGE - SHEET_TOP_RESERVE);
  inside(open, 390, 360);
});

test('a sheet on a tablet keeps a panel width, centred', () => {
  const pos = placeSheet({ width: 1024, height: 400 });
  assert.equal(pos.width, 640);
  assert.equal(pos.left, (1024 - 640) / 2);
  inside(pos, 1024, 400);
});

test('the sheet is for touch-first or phone-wide screens only', () => {
  assert.equal(wantsSheet({ width: 1280, height: 800 }, false), false);
  assert.equal(wantsSheet({ width: 1280, height: 800 }, true), true);
  assert.equal(wantsSheet({ width: 390, height: 844 }, false), true);
});

/** Mounted with a fake `visualViewport`: the panel lives in a box pinned on
 *  it, and follows the keyboard as it opens. */
test('the popover follows the visual viewport when the keyboard opens, and the sheet stays at its foot', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<button id="anchor">a</button><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: 844, configurable: true });
  const vv = Object.assign(new dom.window.EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 });
  Object.defineProperty(dom.window, 'visualViewport', { value: vv, configurable: true });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AnchoredPopover } = await import('../components/anchored-popover');
  const anchor = dom.window.document.getElementById('anchor')!;
  // The composer's chip, at the foot of the phone.
  let chipTop = 780;
  anchor.getBoundingClientRect = () => ({ left: 16, top: chipTop, right: 48, bottom: chipTop + 32, width: 32, height: 32, x: 16, y: chipTop, toJSON: () => ({}) });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const render = (sheet: boolean) => root.render(React.createElement(AnchoredPopover, {
    open: true, onClose: () => {}, anchorRef: { current: anchor }, label: 'Panel', width: 420, maxHeight: 484, align: 'start', sheet,
  }, React.createElement('p', null, 'body')));
  const panel = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  const area = () => document.querySelector<HTMLElement>('[data-popover-area]')!;
  try {
    await React.act(async () => { render(false); });
    assert.equal(panel().dataset.side, 'above');
    assert.equal(area().style.top, '0px');
    assert.equal(area().style.height, '844px');
    assert.equal(panel().style.bottom, `${844 - 780 + POPOVER_GAP}px`);

    // The keyboard slides in: 360px left, the page scrolled 250px so the chip stays in sight.
    await React.act(async () => {
      Object.assign(vv, { height: 360, offsetTop: 250 });
      chipTop = 530;
      vv.dispatchEvent(new dom.window.Event('resize'));
    });
    assert.equal(area().style.top, '250px', 'the box is pinned on the visible area');
    assert.equal(area().style.height, '360px');
    assert.equal(panel().dataset.side, 'above');
    assert.equal(panel().style.bottom, `${360 - (530 - 250) + POPOVER_GAP}px`);
    assert.equal(panel().style.maxHeight, `${530 - 250 - POPOVER_GAP - POPOVER_EDGE}px`);

    // As a sheet (390px is a phone): at the foot of the visible area, above the keyboard.
    await React.act(async () => { render(true); });
    assert.equal(panel().dataset.side, 'sheet');
    assert.equal(panel().style.bottom, `${POPOVER_EDGE}px`);
    assert.equal(panel().style.width, `${390 - 2 * POPOVER_EDGE}px`);
    assert.equal(panel().style.maxHeight, `${360 - POPOVER_EDGE - SHEET_TOP_RESERVE}px`);

    // The keyboard leaves: still a sheet, its foot back at the screen's.
    await React.act(async () => {
      Object.assign(vv, { height: 844, offsetTop: 0 });
      chipTop = 780;
      vv.dispatchEvent(new dom.window.Event('resize'));
    });
    assert.equal(panel().dataset.side, 'sheet');
    assert.equal(area().style.height, '844px');
    assert.equal(panel().style.maxHeight, '484px');
  } finally {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
