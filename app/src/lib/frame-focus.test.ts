import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrameFocusTracker, decideFrameFocus, isHostTextField, type FrameFocusSignals } from './frame-focus';

const NOW = 100_000;
const base: FrameFocusSignals = {
  now: NOW, tab: null, armed: false, pointerOver: false, lastHostKeyAt: null,
  fromTextField: false, touch: false, thefts: 0, reactivated: false,
};
const theft = { kind: 'restore', theft: true, arm: false };

test('Tab from the neighbour, then entry: allowed', () => {
  assert.deepEqual(decideFrameFocus({ ...base, tab: { at: NOW - 40, shift: false, fromNeighbour: true } }), { kind: 'allow' });
});

test('Shift+Tab from the neighbour after the card: allowed', () => {
  assert.deepEqual(decideFrameFocus({ ...base, tab: { at: NOW - 40, shift: true, fromNeighbour: true } }), { kind: 'allow' });
});

test('a Tab older than 500 ms is worth nothing', () => {
  assert.deepEqual(decideFrameFocus({ ...base, tab: { at: NOW - 600, shift: false, fromNeighbour: true } }), theft);
});

test('the card\'s entry control: allowed', () => {
  assert.deepEqual(decideFrameFocus({ ...base, armed: true }), { kind: 'allow' });
});

test('Tab from an element that is not the iframe\'s neighbour: restored', () => {
  assert.deepEqual(decideFrameFocus({ ...base, tab: { at: NOW - 40, shift: false, fromNeighbour: false } }), theft);
});

test('mouse over, no typing, focus coming from a host button: allowed', () => {
  assert.deepEqual(decideFrameFocus({ ...base, pointerOver: true }), { kind: 'allow' });
});

test('mouse over but a host key less than 1 s ago: restored', () => {
  assert.deepEqual(decideFrameFocus({ ...base, pointerOver: true, lastHostKeyAt: NOW - 300 }), theft);
  assert.deepEqual(decideFrameFocus({ ...base, pointerOver: true, lastHostKeyAt: NOW - 1200 }), { kind: 'allow' });
});

test('mouse over, focus coming from the composer, no typing: restored under the layer, not counted', () => {
  assert.deepEqual(decideFrameFocus({ ...base, pointerOver: true, fromTextField: true }), { kind: 'restore', theft: false, arm: true });
  // The click on the layer, which the host sees, arms the card.
  assert.deepEqual(decideFrameFocus({ ...base, pointerOver: true, fromTextField: true, armed: true }), { kind: 'allow' });
});

test('an entry with no signal at all (focus by script): restored', () => {
  assert.deepEqual(decideFrameFocus(base), theft);
});

test('touch without arming: restored under the layer; armed: allowed', () => {
  assert.deepEqual(decideFrameFocus({ ...base, touch: true, pointerOver: true }), { kind: 'restore', theft: true, arm: true });
  assert.deepEqual(decideFrameFocus({ ...base, touch: true, armed: true }), { kind: 'allow' });
});

test('third theft neutralizes; after reactivation, one suffices', () => {
  assert.deepEqual(decideFrameFocus({ ...base, thefts: 1 }), theft);
  assert.deepEqual(decideFrameFocus({ ...base, thefts: 2 }), { kind: 'neutralize' });
  assert.deepEqual(decideFrameFocus({ ...base, reactivated: true }), { kind: 'neutralize' });
});

async function dom() {
  const { JSDOM } = await import('jsdom');
  const window = new JSDOM(`<!doctype html><body>
    <textarea id="composer"></textarea>
    <section id="card"><button id="enter">Interact</button><iframe id="frame" title="doc"></iframe></section>
    <button id="after">After</button>
  </body>`, { url: 'http://localhost/' }).window;
  const doc = window.document;
  const el = (id: string) => doc.getElementById(id) as HTMLElement;
  return { window, doc, el, iframe: el('frame') as HTMLIFrameElement };
}

function key(doc: Document, k: string, shift = false) {
  const view = doc.defaultView!;
  doc.activeElement?.dispatchEvent(new view.KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true }));
}

function pointer(target: Element, type: 'pointerenter' | 'pointerleave', pointerType = 'mouse') {
  const view = target.ownerDocument.defaultView!;
  const event = new view.MouseEvent(type);
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  target.dispatchEvent(event);
}

test('tracker: a theft gives the focus back to the element that had it, and the third makes the iframe inert', async () => {
  const { doc, el, iframe } = await dom();
  let clock = NOW;
  const tracker = createFrameFocusTracker({ doc, iframe, entry: () => el('enter'), touch: () => false, onChange: () => {}, now: () => clock });
  for (let i = 1; i <= 3; i++) {
    el('composer').focus();
    key(doc, 'a');
    clock += 50;
    iframe.focus();
    assert.equal(doc.activeElement, el('composer'), `theft ${i} given back`);
    assert.equal(tracker.state.thefts, i);
  }
  assert.equal(tracker.state.neutralized, true);
  assert.equal(iframe.hasAttribute('inert'), true);
  tracker.reactivate();
  assert.equal(iframe.hasAttribute('inert'), false);
  el('after').focus();
  iframe.focus();
  assert.equal(tracker.state.neutralized, true, 'one theft suffices after reactivation');
  tracker.dispose();
});

test('tracker: Tab from the entry control enters; Tab from elsewhere does not', async () => {
  const { doc, el, iframe } = await dom();
  let clock = NOW;
  const tracker = createFrameFocusTracker({ doc, iframe, entry: () => el('enter'), touch: () => false, onChange: () => {}, now: () => clock });
  el('enter').focus();
  key(doc, 'Tab');
  iframe.focus();
  assert.equal(doc.activeElement, iframe);
  el('composer').focus();
  key(doc, 'Tab');
  clock += 10;
  iframe.focus();
  assert.equal(doc.activeElement, el('composer'));
  assert.equal(tracker.state.thefts, 1);
  // Shift+Tab from the element right after the card enters.
  el('after').focus();
  key(doc, 'Tab', true);
  iframe.focus();
  assert.equal(doc.activeElement, iframe);
  tracker.dispose();
});

test('tracker: the mouse over the iframe, coming from the composer, raises the layer; arming lets it in', async () => {
  const { doc, el, iframe } = await dom();
  const clock = NOW;
  const tracker = createFrameFocusTracker({ doc, iframe, entry: () => el('enter'), touch: () => false, onChange: () => {}, now: () => clock });
  pointer(iframe, 'pointerenter');
  el('composer').focus();
  iframe.focus();
  assert.equal(doc.activeElement, el('composer'));
  assert.equal(tracker.state.overlay, true);
  assert.equal(tracker.state.thefts, 0);
  tracker.arm();
  iframe.focus();
  assert.equal(doc.activeElement, iframe);
  assert.equal(tracker.state.overlay, false);
  // A touch pointer is not a hover.
  el('after').focus();
  pointer(iframe, 'pointerleave');
  pointer(iframe, 'pointerenter', 'touch');
  iframe.focus();
  assert.equal(doc.activeElement, el('after'));
  tracker.dispose();
});

test('tracker: the previous holder gone, the focus goes to the entry control, never to the composer', async () => {
  const { doc, el, iframe } = await dom();
  const tracker = createFrameFocusTracker({ doc, iframe, entry: () => el('enter'), touch: () => false, onChange: () => {}, now: () => NOW });
  el('after').focus();
  el('after').remove();
  iframe.focus();
  assert.equal(doc.activeElement, el('enter'));
  tracker.dispose();
});

test('text fields of the host', async () => {
  const { doc } = await dom();
  const make = (html: string) => { const d = doc.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
  assert.equal(isHostTextField(make('<textarea></textarea>')), true);
  assert.equal(isHostTextField(make('<input type="search">')), true);
  assert.equal(isHostTextField(make('<input type="checkbox">')), false);
  assert.equal(isHostTextField(make('<button>x</button>')), false);
  assert.equal(isHostTextField(make('<div contenteditable="true">x</div>')), true);
  assert.equal(isHostTextField(null), false);
});
