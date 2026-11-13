/**
 * The mascot's geometry, pure: skull outlines, fur colours and the eye
 * glyphs. Every glyph is a closed outline resampled to the same number of
 * points, so any expression can morph into any other point by point.
 */

import { NATURAL_FURS, type MascotShape } from './agent-look';
import { mascotPartOf } from './mascot-parts';
import type { MascotPartId } from '@/lib/mascot/parts-contract';

export type Point = [number, number];
export type Outline = Point[];

/* ---------- Skulls ---------- */

/** Top width, bottom width, height and corner radius, in a 100×100 box whose head sits on y = 92. */
type Skull = { tw: number; bw: number; h: number; r: number };
const SKULLS: Readonly<Record<MascotShape, Skull>> = {
  squircle: { tw: 82, bw: 82, h: 66, r: 26 },
  tri: { tw: 62, bw: 88, h: 70, r: 24 },
  gem: { tw: 86, bw: 66, h: 72, r: 28 },
  round: { tw: 74, bw: 74, h: 74, r: 36 },
  bean: { tw: 94, bw: 94, h: 54, r: 24 },
  cloud: { tw: 62, bw: 66, h: 82, r: 28 },
  hex: { tw: 80, bw: 80, h: 72, r: 11 },
};

/**
 * The skull of a shape: the product's, or a pack's (four numbers checked
 * against `SKULL_BOUNDS` when it registered — a pack cannot draw a free
 * outline, so ears, mask, screen and accessory still land on it). Unknown,
 * or its pack gone: the classic skull.
 */
function skullOf(shape: string): Skull {
  const own = (SKULLS as Readonly<Record<string, Skull>>)[shape];
  if (own) return own;
  const pack = mascotPartOf('shape', shape);
  return pack ? { tw: pack.skull.top, bw: pack.skull.bottom, h: pack.skull.height, r: pack.skull.radius } : SKULLS.squircle;
}

/** The head's extent in the 100×100 box: what a scene that stacks heads (the onboarding's avalanche) collides. */
export function skullSize(shape: MascotShape | MascotPartId): { tw: number; bw: number; h: number } {
  const H = skullOf(shape);
  return { tw: H.tw, bw: H.bw, h: H.h };
}

/* ---------- Colours ---------- */

const channels = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c: readonly number[]): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Lightens toward white (`amt` > 0) or darkens toward black (`amt` < 0). */
export function shade(hex: string, amt: number): string {
  return toHex(channels(hex).map((v) => (amt >= 0 ? v + (255 - v) * amt : v * (1 + amt))));
}
export function mix(a: string, b: string, k: number): string {
  const ca = channels(a);
  const cb = channels(b);
  return toHex(ca.map((v, i) => v * (1 - k) + (cb[i] ?? 0) * k));
}
export function luma(hex: string): number {
  const [r, g, b] = channels(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
/** A natural pelt as is; any other colour blended into a meerkat brown, so a dyed head stays fur. */
export function furOf(color: string, tint = 0.55): string {
  const c = color.toLowerCase();
  return (NATURAL_FURS as readonly string[]).includes(c) ? c : mix(c, '#c9935f', tint);
}

/** A closed polygon with quadratic rounded corners, as an SVG path. */
export function roundedPoly(pts: readonly Point[], r: number): string {
  let d = '';
  pts.forEach((p, i) => {
    const prev = pts[(i + pts.length - 1) % pts.length]!;
    const next = pts[(i + 1) % pts.length]!;
    const toward = (q: Point, len: number): Point => {
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const l = Math.hypot(dx, dy);
      const k = Math.min(len, l / 2) / l;
      return [p[0] + dx * k, p[1] + dy * k];
    };
    const a = toward(prev, r);
    const b = toward(next, r);
    d += `${i ? 'L' : 'M'}${f2(a[0])} ${f2(a[1])}Q${f2(p[0])} ${f2(p[1])} ${f2(b[0])} ${f2(b[1])}`;
  });
  return `${d}Z`;
}
const f2 = (v: number): string => v.toFixed(2);

/* ---------- Head layout ---------- */

/** Where the eyes sit on the screen: scale, the two eye centres, the middle, the vertical centre. */
export type ScreenGeometry = { k: number; c1: number; c2: number; cm: number; cy: number };

export type HeadLayout = {
  top: number;
  bottomWidth: number;
  head: string;
  screen: { x: number; y: number; w: number; h: number };
  ring: { x: number; y: number; w: number; h: number };
  ears: { y: number; r: number; left: number; right: number };
  geo: ScreenGeometry;
};

export function headLayout(shape: MascotShape | MascotPartId): HeadLayout {
  const H = skullOf(shape);
  const top = 92 - H.h;
  const mid = (H.tw + H.bw) / 2;
  const cy = top + H.h * 0.55;
  const head = roundedPoly([[50 - H.tw / 2, top], [50 + H.tw / 2, top], [50 + H.bw / 2, 92], [50 - H.bw / 2, 92]], H.r);
  // The screen takes 64 % × 44 % of the head; the fur ring around it 84 % × 68 %.
  const sw = mid * 0.64;
  const sh = H.h * 0.44;
  const mw = mid * 0.84;
  const mh = H.h * 0.68;
  // Meerkat ears sit low on the skull.
  const earT = 0.6;
  const earY = top + H.h * earT;
  const e = 11 * Math.min(1.1, H.h / 66);
  const wAt = H.tw + (H.bw - H.tw) * earT;
  return {
    top,
    bottomWidth: H.bw,
    head,
    screen: { x: 50 - sw / 2, y: cy - sh / 2, w: sw, h: sh },
    ring: { x: 50 - mw / 2, y: cy - mh / 2, w: mw, h: mh },
    ears: { y: earY, r: e, left: 50 - wAt / 2 + 2, right: 50 + wAt / 2 - 2 },
    geo: { k: sh / 29, c1: 50 - sw * 0.26, c2: 50 + sw * 0.26, cm: 50, cy: cy + 0.5 },
  };
}

/* ---------- Eye glyphs ---------- */

/** Points per eye outline: every glyph is resampled to it, so any morphs into any. */
export const EYE_POINTS = 72;

function rrect(w: number, h: number, radius: number): Outline {
  const pts: Outline = [];
  const x0 = -w / 2;
  const y0 = -h / 2;
  const x1 = w / 2;
  const y1 = h / 2;
  const r = Math.min(radius, w / 2, h / 2);
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 10; i += 1) {
      const a = a0 + (i / 10) * Math.PI / 2;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  corner(x1 - r, y0 + r, -Math.PI / 2);
  corner(x1 - r, y1 - r, 0);
  corner(x0 + r, y1 - r, Math.PI / 2);
  corner(x0 + r, y0 + r, Math.PI);
  return pts;
}
const ellipse = (rx: number, ry = rx): Outline => Array.from({ length: 48 }, (_, i): Point => {
  const a = -Math.PI / 2 + (i / 48) * Math.PI * 2;
  return [rx * Math.cos(a), ry * Math.sin(a)];
});
/** A thick stroke along a centreline, with round caps, as one closed outline. */
function stroke(line: readonly Point[], hw: number): Outline {
  const n = line.length;
  const left: Outline = [];
  const right: Outline = [];
  const dir = (i: number): Point => {
    const a = line[Math.max(0, i - 1)]!;
    const b = line[Math.min(n - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const d = Math.hypot(dx, dy) || 1;
    return [dx / d, dy / d];
  };
  for (let i = 0; i < n; i += 1) {
    const [dx, dy] = dir(i);
    const p = line[i]!;
    left.push([p[0] - dy * hw, p[1] + dx * hw]);
    right.push([p[0] + dy * hw, p[1] - dx * hw]);
  }
  const cap = (p: Point, [dx, dy]: Point): Outline => {
    const out: Outline = [];
    const a0 = Math.atan2(dx, -dy);
    for (let i = 1; i < 10; i += 1) {
      const a = a0 - (i / 10) * Math.PI;
      out.push([p[0] + hw * Math.cos(a), p[1] + hw * Math.sin(a)]);
    }
    return out;
  };
  const end = dir(n - 1);
  const start = dir(0);
  return [...left, ...cap(line[n - 1]!, end), ...right.reverse(), ...cap(line[0]!, [-start[0], -start[1]])];
}
const seg = (a: Point, b: Point, k = 12): Outline => Array.from({ length: k }, (_, i): Point => [
  a[0] + (b[0] - a[0]) * i / (k - 1), a[1] + (b[1] - a[1]) * i / (k - 1),
]);
const quad = (a: Point, c: Point, b: Point, k = 24): Outline => Array.from({ length: k }, (_, i): Point => {
  const t = i / (k - 1);
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
});
const chevron = (flip: number): Outline => stroke([...seg([3 * flip, -5.6], [-2.6 * flip, 0]), ...seg([-2.6 * flip, 0], [3 * flip, 5.6]).slice(1)], 1.55);

const GLYPHS = {
  pill: () => rrect(5.4, 12.4, 2.7),
  big: () => rrect(9.4, 13.4, 4.4),
  happy: () => stroke(quad([-5.4, 2.4], [0, -5.2], [5.4, 2.4]), 1.6),
  sad: () => stroke(quad([-5.4, -1.6], [0, 5.6], [5.4, -1.6]), 1.6),
  sleepy: () => rrect(10.4, 3, 1.5),
  round: () => ellipse(4.7),
  dot: () => ellipse(2.5),
  none: () => ellipse(0.01),
  heart: () => Array.from({ length: 60 }, (_, i): Point => {
    const t = (i / 60) * Math.PI * 2;
    return [0.4 * 16 * Math.sin(t) ** 3, -0.4 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) - 0.6];
  }),
  star: () => Array.from({ length: 10 }, (_, i): Point => {
    const a = -Math.PI / 2 + i * Math.PI / 5;
    const r = i % 2 ? 2.9 : 7;
    return [r * Math.cos(a), r * Math.sin(a) + 0.6];
  }),
  cross: () => {
    const w = 1.6;
    const l = 5.4;
    const c = Math.SQRT1_2;
    const pts: Outline = [[-w, -l], [w, -l], [w, -w], [l, -w], [l, w], [w, w], [w, l], [-w, l], [-w, w], [-l, w], [-l, -w], [-w, -w]];
    return pts.map(([x, y]): Point => [c * (x - y), c * (x + y)]);
  },
  lt: () => chevron(1),
  gt: () => chevron(-1),
  slash: () => stroke(seg([2.6, -6.2], [-2.6, 6.2], 16), 1.5),
  squint: () => rrect(7.4, 5.2, 2.6),
  angryL: () => rrect(5.4, 12.4, 2.7).map(([x, y]): Point => [x, y + (y < 0 ? x * 0.55 : 0)]),
  angryR: () => rrect(5.4, 12.4, 2.7).map(([x, y]): Point => [x, y - (y < 0 ? x * 0.55 : 0)]),
} satisfies Record<string, () => Outline>;
type Glyph = keyof typeof GLYPHS;

/** An expression: what each slot shows (left eye, right eye, a middle glyph) and where, in screen units (screen height 29). */
type Expression = { L: Glyph; R: Glyph; M?: Glyph; lx?: number; rx?: number };
const EXPR = {
  pill: { L: 'pill', R: 'pill' },
  happy: { L: 'happy', R: 'happy' },
  wink: { L: 'pill', R: 'happy' },
  big: { L: 'big', R: 'big' },
  sleepy: { L: 'sleepy', R: 'sleepy' },
  sad: { L: 'sad', R: 'sad' },
  angry: { L: 'angryL', R: 'angryR' },
  surprised: { L: 'round', R: 'round' },
  heart: { L: 'heart', R: 'heart' },
  star: { L: 'star', R: 'star' },
  x: { L: 'cross', R: 'cross' },
  dots: { L: 'dot', R: 'dot', M: 'dot', lx: -8, rx: 8 },
  code: { L: 'lt', R: 'gt', M: 'slash', lx: -9, rx: 9 },
  squint: { L: 'squint', R: 'squint' },
  quizzical: { L: 'round', R: 'sleepy' },
  skeptic: { L: 'sleepy', R: 'pill' },
} as const satisfies Record<string, Expression>;
export type MascotExpression = keyof typeof EXPR;
export const EXPRESSIONS = Object.keys(EXPR) as MascotExpression[];

/** What the eyes may show: one of the product's expressions, or a pack's eyes (`<pluginId>:<slug>`). */
export type MascotEyesKey = MascotExpression | MascotPartId;

export function isMascotExpression(value: unknown): value is MascotExpression {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EXPR, value);
}

/** An expression of the product, or a pack's eyes registered now. */
export function isDrawableEyes(value: unknown): value is MascotEyesKey {
  return isMascotExpression(value) || mascotPartOf('eyes', value) !== null;
}

/** Resamples a closed outline to `n` points evenly spaced, counter-clockwise, starting at the top. */
export function resample(poly: readonly Point[], n = EYE_POINTS): Outline {
  let area = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  const P = area < 0 ? poly.slice().reverse() : poly;
  const len = [0];
  for (let i = 1; i <= P.length; i += 1) {
    const a = P[i - 1]!;
    const b = P[i % P.length]!;
    len.push(len[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = len[len.length - 1]!;
  const out: Outline = [];
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (i / n) * total;
    while (len[j + 1]! < d) j += 1;
    const a = P[j]!;
    const b = P[(j + 1) % P.length]!;
    const t = (d - len[j]!) / ((len[j + 1]! - len[j]!) || 1);
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  const cx = out.reduce((s, p) => s + p[0], 0) / n;
  const cy = out.reduce((s, p) => s + p[1], 0) / n;
  // Every outline starts at its topmost direction: two glyphs then pair their
  // points the same way round, and a morph never twists.
  let best = 0;
  let bd = Infinity;
  out.forEach(([x, y], i) => {
    const d = Math.abs(Math.atan2(y - cy, x - cx) + Math.PI / 2);
    if (d < bd) { bd = d; best = i; }
  });
  return [...out.slice(best), ...out.slice(0, best)];
}

const glyphCache = new Map<Glyph, Outline>();
function glyphPoints(name: Glyph): Outline {
  let pts = glyphCache.get(name);
  if (!pts) { pts = resample(GLYPHS[name]()); glyphCache.set(name, pts); }
  return pts;
}

export type EyeSlots = { L: Outline; R: Outline; M: Outline };

type PackEyes = { L: Outline; R: Outline; M: Outline };
/** Keyed by the part object: a pack registered again brings new outlines, the old ones are dropped with it. */
const packEyesCache = new WeakMap<object, PackEyes>();

/** A pack's eyes, resampled like a glyph; the right eye mirrors the left when the pack draws one only. */
function packEyes(id: string): PackEyes | null {
  const part = mascotPartOf('eyes', id);
  if (!part) return null;
  let eyes = packEyesCache.get(part);
  if (!eyes) {
    const left = part.left.map(([x, y]): Point => [x, y]);
    const right = part.right ? part.right.map(([x, y]): Point => [x, y]) : left.map(([x, y]): Point => [-x, y]);
    eyes = {
      L: resample(left),
      R: resample(right),
      M: part.middle ? resample(part.middle.map(([x, y]): Point => [x, y])) : glyphPoints('none'),
    };
    packEyesCache.set(part, eyes);
  }
  return eyes;
}

/** Whether these eyes blink: a product expression per `NO_BLINK`, a pack's unless it says `blink: false`. */
export function packEyesBlink(id: string): boolean | null {
  const part = mascotPartOf('eyes', id);
  return part ? part.blink !== false : null;
}

/**
 * Absolute points of the three slots of an expression on a given screen. A
 * pack's eyes whose plugin left show the plain pill, like an unknown name.
 */
export function exprPoints(name: MascotEyesKey, geo: ScreenGeometry): EyeSlots {
  const place = (pts: Outline, x: number): Outline => pts.map(([px, py]): Point => [x + px * geo.k, geo.cy + py * geo.k]);
  const pack = isMascotExpression(name) ? null : packEyes(name);
  if (pack) return { L: place(pack.L, geo.c1), R: place(pack.R, geo.c2), M: place(pack.M, geo.cm) };
  const e: Expression = (EXPR as Readonly<Record<string, Expression>>)[name] ?? EXPR.pill;
  const lx = e.lx !== undefined ? geo.cm + e.lx * geo.k : geo.c1;
  const rx = e.rx !== undefined ? geo.cm + e.rx * geo.k : geo.c2;
  return { L: place(glyphPoints(e.L), lx), R: place(glyphPoints(e.R), rx), M: place(glyphPoints(e.M ?? 'none'), geo.cm) };
}

export function ptsPath(pts: readonly Point[]): string {
  return `M${pts.map((p) => `${f2(p[0])} ${f2(p[1])}`).join('L')}Z`;
}
