/**
 * The shared frame of the live mascots follows the pointer without layout
 * thrashing (TODO #874): a pointer move only records the position, and the
 * next frame reads every follower's box before it writes a single eye.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { headLayout } from './mascot-geometry';
import type { MascotState } from './mascot-states';

const SVG = 'http://www.w3.org/2000/svg';

type World = {
  window: import('jsdom').JSDOM['window'];
  /** Runs the frame the engine asked for, if any; `false` when none is pending. */
  runFrame(t: number): boolean;
};

async function world(ctx: TestContext): Promise<World> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('document', dom.window.document);
  let pending: FrameRequestCallback | null = null;
  install('requestAnimationFrame', (fn: FrameRequestCallback) => { pending = fn; return 1; });
  install('cancelAnimationFrame', () => { pending = null; });
  ctx.after(() => {
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  return {
    window: dom.window,
    runFrame(t) {
      const fn = pending;
      pending = null;
      if (!fn) return false;
      fn(t);
      return true;
    },
  };
}

/** A mascot's nodes in the page, its box at `left`, logging box reads and eye writes. */
function mascotNodes(doc: Document, log: string[], id: string, left: number) {
  const svg = doc.createElementNS(SVG, 'svg') as SVGSVGElement;
  const eyes = doc.createElementNS(SVG, 'g') as SVGGElement;
  const blink = doc.createElementNS(SVG, 'g') as SVGGElement;
  const path = () => doc.createElementNS(SVG, 'path') as SVGPathElement;
  const paths = { L: path(), R: path(), M: path() };
  blink.append(paths.L, paths.R, paths.M);
  eyes.append(blink);
  svg.append(eyes);
  doc.body.append(svg);
  svg.getBoundingClientRect = () => {
    log.push(`read:${id}`);
    return { left, top: 0, width: 100, height: 100, right: left + 100, bottom: 100, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  const write = eyes.setAttribute.bind(eyes);
  eyes.setAttribute = (name: string, value: string) => {
    if (name === 'transform') log.push(`write:${id}`);
    write(name, value);
  };
  return { svg, eyes, blink, paths };
}

test('a pointer move reads no box; the next frame reads them all, then writes', async (t) => {
  const w = await world(t);
  const { startMascotMotion, liveMascotCount } = await import('./mascot-motion');
  const geo = headLayout('squircle').geo;
  const log: string[] = [];
  const doc = w.window.document;
  const followers = ['a', 'b', 'c'].map((id, i) => ({ id, nodes: mascotNodes(doc, log, id, i * 200) }));
  // A state with a gaze of its own does not look at the pointer: its box is never read.
  const glancing = mascotNodes(doc, log, 'own', 600);
  const engines = [
    ...followers.map(({ nodes }) => startMascotMotion(nodes, geo, 'pill', null)),
    startMascotMotion(glancing, geo, 'pill', 'thinking' satisfies MascotState),
  ];
  assert.equal(liveMascotCount(), 4);
  log.splice(0);

  const move = (x: number, y: number) => w.window.dispatchEvent(new w.window.MouseEvent('pointermove', { clientX: x, clientY: y }));
  for (let x = 0; x < 10; x += 1) move(x * 50, 400);
  move(330, 400);
  assert.equal(log.length, 0, 'no layout read while the pointer moves');

  assert.ok(w.runFrame(performance.now() + 16));
  const follow = log.filter((e) => !e.endsWith(':own'));
  assert.deepEqual(follow, ['read:a', 'read:b', 'read:c', 'write:a', 'write:b', 'write:c'], 'reads first, then writes, one each');
  assert.ok(!log.includes('read:own'));
  // The last position wins: the pointer (330, 400) is right of `a`'s centre, left of `c`'s.
  const dx = (eyes: SVGGElement) => Number(/translate\(([-\d.]+)/.exec(eyes.getAttribute('transform') ?? '')?.[1]);
  assert.ok(dx(followers[0]!.nodes.eyes) > 0);
  assert.ok(dx(followers[2]!.nodes.eyes) < 0);

  log.splice(0);
  assert.ok(w.runFrame(performance.now() + 32));
  assert.ok(!log.some((e) => e.startsWith('read:')), 'a frame without a move reads nothing');

  // A move pending when the last mascot leaves is dropped with the listener.
  move(10, 10);
  for (const engine of engines) engine.dispose();
  assert.equal(liveMascotCount(), 0);
  log.splice(0);
  w.runFrame(performance.now() + 48);
  assert.equal(log.length, 0);
});
