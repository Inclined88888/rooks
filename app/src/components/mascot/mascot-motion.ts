/**
 * The live mascot: eyes sprung from one glyph to the next, an asymmetric
 * blink, the state's cadence and gaze. It writes straight to the SVG nodes,
 * one shared animation frame for every mascot on screen — React re-renders
 * nothing at 120 Hz. Never started under `prefers-reduced-motion`.
 */

import { exprPoints, ptsPath, type EyeSlots, type MascotEyesKey, type MascotExpression, type Point, type ScreenGeometry } from './mascot-geometry';
import { STATES, blinks, type MascotState, type MascotStateSpec } from './mascot-states';

export type MascotNodes = {
  svg: SVGSVGElement;
  eyes: SVGGElement;
  blink: SVGGElement;
  paths: { L: SVGPathElement; R: SVGPathElement; M: SVGPathElement };
};

export type MascotMotion = {
  /** The look's eyes changed: the mascot springs to them unless its state shows something else. */
  setBase(expr: MascotEyesKey): void;
  /** `null`: hold the look's eyes, blinking and following the pointer. */
  setState(state: MascotState | null): void;
  dispose(): void;
};

/** Classes the engine puts on the svg for a body move (globals.css, `.rooks-mascot-*`). */
export const MOVE_CLASSES = { jump: 'rooks-mascot-jump', wiggle: 'rooks-mascot-wiggle', hop: 'rooks-mascot-hop' } as const;

const SLOTS = ['L', 'R', 'M'] as const;
/** Spring stiffness and damping ratio, integrated at a fixed 120 Hz whatever the display rate. */
const W = 26;
const Z = 0.62;
const STEP = 1 / 120;
const BLINK_MS = 320;

type Live = {
  nodes: MascotNodes;
  geo: ScreenGeometry;
  cur: EyeSlots;
  vel: Record<'L' | 'R' | 'M', Point[]>;
  target: EyeSlots;
  base: MascotEyesKey;
  expr: MascotEyesKey;
  state: MascotState | null;
  moving: boolean;
  blinkAt: number;
  blinkStart: number;
  nextAt: number;
  ownGaze: boolean;
  gaze: Point;
  gazeTo: Point;
  glanceSide: number;
};

const live = new Set<Live>();
let frame = 0;
let last = 0;
let carry = 0;

const rnd = ([a, b]: readonly [number, number]): number => a + Math.random() * (b - a);
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clone = (slots: EyeSlots): EyeSlots => ({ L: slots.L.map((p): Point => [p[0], p[1]]), R: slots.R.map((p): Point => [p[0], p[1]]), M: slots.M.map((p): Point => [p[0], p[1]]) });
const specOf = (st: Live): MascotStateSpec => STATES[st.state ?? 'idle'];

function paint(st: Live): void {
  for (const s of SLOTS) st.nodes.paths[s].setAttribute('d', ptsPath(st.cur[s]));
}

function show(st: Live, expr: MascotEyesKey): void {
  st.expr = expr;
  st.target = exprPoints(expr, st.geo);
  st.moving = true;
}

function pick(st: Live, entry: MascotExpression | 'base'): MascotEyesKey {
  return entry === 'base' ? st.base : entry;
}

function replay(svg: SVGSVGElement, cls: string): void {
  svg.classList.remove(MOVE_CLASSES.jump, MOVE_CLASSES.wiggle);
  // Reading layout restarts a CSS animation that the same class already ran.
  void svg.getBoundingClientRect();
  svg.classList.add(cls);
}

function tick(t: number): void {
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  carry += dt;
  // First, before this frame writes anything: the boxes read the layout the last frame left.
  followPointer();
  for (const st of live) {
    if (!st.nodes.svg.isConnected) continue;
    if (st.moving) {
      let acc = carry;
      while (acc >= STEP) {
        acc -= STEP;
        for (const s of SLOTS) {
          const c = st.cur[s];
          const v = st.vel[s];
          const tg = st.target[s];
          for (let i = 0; i < c.length; i += 1) {
            const vi = v[i]!;
            const ci = c[i]!;
            const ti = tg[i]!;
            vi[0] += (-2 * Z * W * vi[0] - W * W * (ci[0] - ti[0])) * STEP;
            vi[1] += (-2 * Z * W * vi[1] - W * W * (ci[1] - ti[1])) * STEP;
            ci[0] += vi[0] * STEP;
            ci[1] += vi[1] * STEP;
          }
        }
      }
      let energy = 0;
      for (const s of SLOTS) {
        const c = st.cur[s];
        const tg = st.target[s];
        for (let i = 0; i < c.length; i += 1) energy += Math.abs(c[i]![0] - tg[i]![0]) + Math.abs(c[i]![1] - tg[i]![1]);
      }
      paint(st);
      if (energy < 0.02) st.moving = false;
    }
    const spec = specOf(st);
    // Blink: closes in 42 % of its time, reopens in 58 %, never below 4 %.
    if (st.blinkStart < 0 && t >= st.blinkAt && blinks(st.expr)) st.blinkStart = t;
    if (st.blinkStart >= 0) {
      const p = (t - st.blinkStart) / BLINK_MS;
      const sc = p >= 1 ? 1 : p < 0.42 ? 1 - (p / 0.42) * 0.96 : 0.04 + ((p - 0.42) / 0.58) * 0.96;
      st.nodes.blink.setAttribute('transform', `translate(0 ${st.geo.cy}) scale(1 ${sc.toFixed(3)}) translate(0 ${-st.geo.cy})`);
      if (p >= 1) {
        st.blinkStart = -1;
        // One blink in seven comes as a double blink.
        st.blinkAt = spec.blink ? t + (Math.random() < 0.15 ? 180 : rnd(spec.blink)) : Infinity;
      }
    }
    if (t >= st.nextAt) {
      const pool = spec.pool.map((e) => pick(st, e));
      const choices = pool.length > 1 ? pool.filter((x) => x !== st.expr) : pool;
      const next = choices[Math.floor(Math.random() * choices.length)];
      if (next) show(st, next);
      st.nextAt = st.state ? t + rnd(spec.every) : Infinity;
      st.glanceSide *= -1;
      if (spec.enter === 'jump' && spec.bounce) replay(st.nodes.svg, MOVE_CLASSES.jump);
    }
    if (st.ownGaze) {
      if (spec.gaze === 'glance') st.gazeTo = [2.4 * st.glanceSide, -1.6];
      else if (spec.gaze === 'scan') {
        if (t >= scanAt(st)) { st.gazeTo = [st.gazeTo[0] > 0 ? -2.8 : 2.8, (Math.random() - 0.5) * 1.2]; scans.set(st, t + 380 + Math.random() * 300); }
      } else if (Array.isArray(spec.gaze)) st.gazeTo = [spec.gaze[0], spec.gaze[1]];
      const k = Math.min(1, dt * 9);
      st.gaze = [st.gaze[0] + (st.gazeTo[0] - st.gaze[0]) * k, st.gaze[1] + (st.gazeTo[1] - st.gaze[1]) * k];
      st.nodes.eyes.setAttribute('transform', `translate(${st.gaze[0].toFixed(2)} ${st.gaze[1].toFixed(2)})`);
    }
    if (spec.breathe) st.nodes.blink.style.opacity = (0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t / 900))).toFixed(3);
  }
  carry %= STEP;
  frame = live.size > 0 ? requestAnimationFrame(tick) : 0;
}

const scans = new WeakMap<Live, number>();
const scanAt = (st: Live): number => scans.get(st) ?? 0;

/** The last pointer position not yet applied; the shared frame applies it. */
let pointer: Point | null = null;

/**
 * Only records where the pointer is: reading every mascot's box here, between
 * the eye writes of the one before, forced a layout per mascot per move.
 */
function onPointer(e: PointerEvent): void {
  pointer = [e.clientX, e.clientY];
}

/** Eyes follow the pointer on every live mascot whose state looks at it: every box read, then every write. */
function followPointer(): void {
  if (!pointer) return;
  const [x, y] = pointer;
  pointer = null;
  const boxes: Array<[Live, DOMRect]> = [];
  for (const st of live) {
    if (st.ownGaze || !st.nodes.svg.isConnected) continue;
    boxes.push([st, st.nodes.svg.getBoundingClientRect()]);
  }
  for (const [st, b] of boxes) {
    if (!b.width) continue;
    const dx = x - (b.left + b.width / 2);
    const dy = y - (b.top + b.height / 2);
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, d / 300) * 2.6;
    st.nodes.eyes.setAttribute('transform', `translate(${(dx / d * k).toFixed(2)} ${(dy / d * k).toFixed(2)})`);
  }
}

function enroll(st: Live): void {
  if (live.size === 0) window.addEventListener('pointermove', onPointer, { passive: true });
  live.add(st);
  if (!frame) {
    last = now();
    frame = requestAnimationFrame(tick);
  }
}

function leave(st: Live): void {
  live.delete(st);
  if (live.size > 0) return;
  window.removeEventListener('pointermove', onPointer);
  pointer = null;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}

/** How many live mascots the shared frame drives (tests). */
export function liveMascotCount(): number {
  return live.size;
}

export function startMascotMotion(nodes: MascotNodes, geo: ScreenGeometry, base: MascotEyesKey, state: MascotState | null): MascotMotion {
  const cur = exprPoints(base, geo);
  const t = now();
  const st: Live = {
    nodes,
    geo,
    cur: clone(cur),
    vel: { L: cur.L.map((): Point => [0, 0]), R: cur.R.map((): Point => [0, 0]), M: cur.M.map((): Point => [0, 0]) },
    target: cur,
    base,
    expr: base,
    state: null,
    moving: false,
    blinkAt: t + 1200 + Math.random() * 2500,
    blinkStart: -1,
    nextAt: Infinity,
    ownGaze: false,
    gaze: [0, 0],
    gazeTo: [0, 0],
    glanceSide: 1,
  };

  const setState = (next: MascotState | null): void => {
    st.state = next;
    const spec = specOf(st);
    const t0 = now();
    st.nextAt = next ? t0 + rnd(spec.every) : Infinity;
    st.blinkAt = spec.blink ? t0 + rnd(spec.blink) * 0.4 : Infinity;
    st.ownGaze = spec.gaze !== 'pointer';
    st.glanceSide = 1;
    scans.delete(st);
    show(st, next ? pick(st, spec.pool[0] ?? 'base') : st.base);
    if (next && spec.enter) replay(nodes.svg, MOVE_CLASSES[spec.enter]);
    nodes.svg.classList.toggle(MOVE_CLASSES.hop, Boolean(next && spec.bounce));
    if (!spec.breathe) nodes.blink.style.opacity = '';
    if (!st.ownGaze) nodes.eyes.removeAttribute('transform');
  };

  setState(state);
  // React painted the target already; the morph starts from where the eyes were.
  paint(st);
  enroll(st);

  return {
    setBase(expr) {
      st.base = expr;
      if (!st.state || STATES[st.state].pool[0] === 'base') show(st, expr);
      paint(st);
    },
    setState(next) {
      if (next === st.state) return;
      setState(next);
      paint(st);
    },
    dispose() {
      leave(st);
      nodes.svg.classList.remove(MOVE_CLASSES.jump, MOVE_CLASSES.wiggle, MOVE_CLASSES.hop);
    },
  };
}
