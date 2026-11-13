import { packSiblings } from 'd3';

/**
 * Deterministic seed layout of the agents graph: a radial tree per
 * constellation.
 *
 * Every depth sits on one ring around the constellation's root, the rings
 * a fixed step apart; each node gets an angular wedge proportional to the
 * width it needs, and its children share that wedge. A ring only grows
 * past its step when its narrowest wedge could not hold a node, so a link
 * keeps roughly one step of length whatever the size of the subtree
 * behind it. The balloon layout it replaces sized every subtree as a full
 * disc and ringed those discs around their parent: the central links grew
 * with everything hanging below them.
 *
 * A node whose children are all leaves — an unfolded project and its roles —
 * fans them out around itself on a short radius, over less than a full turn,
 * pointing away from the root. It keeps the wedge of a lone node and moves
 * out along its own spoke until the fan clears its neighbours: unfolding one
 * project lengthens its branch only, never its siblings'.
 *
 * Constellations (forest roots) are then packed side by side with
 * `packSiblings`, the main agent's in the centre.
 */

export type LayoutLink = { source: string; target: string };

export type LayoutOptions = {
  /** Screen-size factor (0.45 on narrow phones, 1 on desktop). */
  scale: number;
  cx: number;
  cy: number;
  /** Constellation placed at the centre (the main agent). */
  preferCenter?: string | null;
  /** Frames of the previous layout, keyed by constellation root (cf.
   *  `framesOf`). A constellation found there keeps its centre. */
  previous?: ReadonlyMap<string, Frame> | null;
};

/** Where a constellation sits: its root's centre and the disc it claims. */
export type Frame = { x: number; y: number; r: number };

export type Placement = {
  x: number;
  y: number;
  /** Forest root the node belongs to (its constellation). */
  root: string;
  /** Distance to its parent in the seed, i.e. the link rest length. */
  parentDistance: number | null;
  /** On a constellation's root only: the radius of the disc it claims. */
  extent?: number;
};

/** The frames to hand the next layout, so its constellations stay put. */
export function framesOf(placed: ReadonlyMap<string, Placement>): Map<string, Frame> {
  const frames = new Map<string, Frame>();
  for (const [id, p] of placed) if (p.extent != null) frames.set(id, { x: p.x, y: p.y, r: p.extent });
  return frames;
}

/** Half the minimum gap between two nodes: node disc plus its label. */
export const NODE_CLAIM = 59;
export const GAP = 36;
/** Distance between two rings. Never below two claims, so nodes on
 *  neighbouring rings cannot overlap whatever their angles. */
export const LEVEL = 2 * NODE_CLAIM + 2;

/** Widest arc a fan of sub-agents may open: well short of a full turn, so
 *  an unfolded project reads as a fan, not a flower. */
export const FAN_ARC = Math.PI * 1.5;

/** Half the gap between two sub-agents of one fan: tighter than a
 *  NODE_CLAIM, so they huddle round their agent and read as its own. */
export const FAN_CLAIM = 38;

type Fan = { radius: number; span: number };

type Tree = {
  kids: string[];
  /** Kids on the constellation's rings; empty for a fan, whose kids sit
   *  around the node itself. */
  ringKids: string[];
  depth: number;
  fan: Fan | null;
  /** Share of the parent's wedge: the width it needs, in claims. */
  weight: number;
  /** Angular wedge and the angle at its middle, where the node sits. */
  wedge: number;
  angle: number;
};

export function layoutForest(ids: readonly string[], links: readonly LayoutLink[], opts: LayoutOptions): Map<string, Placement> {
  const k = opts.scale;
  const known = new Set(ids);
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  for (const l of links) {
    if (l.source === l.target || !known.has(l.source) || !known.has(l.target)) continue;
    // One parent per node: a second incoming edge would make the tree a graph.
    if (parentOf.has(l.target)) continue;
    parentOf.set(l.target, l.source);
    const list = childrenOf.get(l.source) ?? [];
    list.push(l.target);
    childrenOf.set(l.source, list);
  }

  // Roots, plus a node per `reports_to` cycle (nobody in a cycle is
  // parentless, so none of them would be reached otherwise).
  const roots = ids.filter((id) => !parentOf.has(id));
  const reached = new Set<string>();
  const reach = (root: string) => {
    const stack = [root];
    while (stack.length) {
      const id = stack.pop()!;
      if (reached.has(id)) continue;
      reached.add(id);
      for (const c of childrenOf.get(id) ?? []) stack.push(c);
    }
  };
  roots.forEach(reach);
  for (const id of [...ids].sort()) {
    if (reached.has(id)) continue;
    roots.push(id);
    reach(id);
  }

  const claim = NODE_CLAIM * k;
  // A node whose kids are all leaves (an unfolded project) fans them out
  // around itself, on a short radius pointing away from the root, instead of
  // sending them to the next ring: that ring would have to be huge, and the
  // rings inside it would be stretched to match.
  const fanFor = (n: number): Fan => {
    const fc = FAN_CLAIM * k;
    const radius = Math.max(2 * fc, fc / Math.sin(Math.min(FAN_ARC / (2 * n), Math.PI / 2)));
    const slot = 2 * Math.asin(Math.min(1, fc / radius));
    return { radius, span: Math.min(FAN_ARC, n * slot * 1.25) };
  };

  const trees = new Map<string, Tree>();
  const build = (id: string, depth: number, seen: Set<string>): Tree => {
    seen.add(id);
    const kids = (childrenOf.get(id) ?? []).filter((c) => !seen.has(c)).sort();
    // Claim the kids before descending, so a node reached twice stays with
    // its first parent.
    kids.forEach((c) => seen.add(c));
    const built = kids.map((c) => build(c, depth + 1, seen));
    const fan = depth > 0 && kids.length > 0 && built.every((c) => !c.kids.length) ? fanFor(kids.length) : null;
    const ringKids = fan ? [] : kids;
    // A fan weighs one node: widening its wedge would squeeze its siblings'
    // and push their whole ring out.
    const weight = ringKids.length ? built.reduce((sum, c) => sum + c.weight, 0) : 1;
    const t: Tree = { kids, ringKids, depth, fan, weight, wedge: 0, angle: 0 };
    trees.set(id, t);
    return t;
  };
  const share = (id: string, start: number, wedge: number) => {
    const t = trees.get(id)!;
    t.wedge = wedge;
    t.angle = start + wedge / 2;
    let a = start;
    for (const c of t.ringKids) {
      const w = (wedge * trees.get(c)!.weight) / t.weight;
      share(c, a, w);
      a += w;
    }
  };
  /** Nodes on a constellation's rings (fanned kids excluded). */
  const members = (root: string): string[] => {
    const out: string[] = [];
    const stack = [root];
    while (stack.length) {
      const id = stack.pop()!;
      out.push(id);
      stack.push(...trees.get(id)!.ringKids);
    }
    return out;
  };

  const out = new Map<string, Placement>();
  /** Ring radii of one constellation, index = depth. */
  const ringsOf = (ids: string[]): number[] => {
    // Two nodes of a ring are at least the narrower of their wedges apart
    // (each arc between them holds half of both), so a ring holds when every
    // wedge spans a chord of the node's width.
    // Fans are left out: they make room along their own spoke (cf. fanOut).
    const need: number[] = [0];
    for (const id of ids) {
      const t = trees.get(id)!;
      if (!t.depth) continue;
      const r = claim / Math.sin(Math.min(t.wedge, Math.PI) / 2);
      need[t.depth] = Math.max(need[t.depth] ?? 0, r);
    }
    const rings = [0];
    for (let d = 1; d < need.length; d++) rings[d] = Math.max(rings[d - 1]! + LEVEL * k, need[d] ?? 0);
    // A crowded outer ring would otherwise leave short stems and long
    // spokes: spread the inner rings evenly up to it.
    const outer = rings.length - 1;
    for (let d = 1; d < outer; d++) rings[d] = Math.max(rings[d]!, (rings[outer]! * d) / outer);
    return rings;
  };

  type Pt = { x: number; y: number };
  const fanKidsAt = (p: Pt, t: Tree): Pt[] => {
    const { radius, span } = t.fan!;
    return t.kids.map((_, i) => {
      const a = t.angle - span / 2 + ((i + 0.5) * span) / t.kids.length;
      return { x: p.x + Math.cos(a) * radius, y: p.y + Math.sin(a) * radius };
    });
  };
  /**
   * Positions of one constellation relative to its root. Every node sits on
   * its ring; a fan then slides out along its spoke, one small step at a
   * time, until the fan and its node clear everything placed so far.
   */
  const placeLocal = (ids: string[], rings: number[]): Map<string, Pt> => {
    const local = new Map<string, Pt>();
    for (const id of ids) {
      const t = trees.get(id)!;
      const r = rings[t.depth]!;
      local.set(id, { x: Math.cos(t.angle) * r, y: Math.sin(t.angle) * r });
    }
    // A sub-agent of a fan is small: its claim plus a full one clears it.
    const min = claim + FAN_CLAIM * k;
    const step = 6 * k;
    const placedKids: Pt[] = [];
    const fans = ids.filter((id) => trees.get(id)!.fan).sort();
    for (const id of fans) {
      const t = trees.get(id)!;
      const others = [...ids.filter((m) => m !== id).map((m) => local.get(m)!), ...placedKids];
      const clear = (pts: Pt[]) => pts.every((p) => others.every((o) => Math.hypot(p.x - o.x, p.y - o.y) >= min));
      let r = rings[t.depth]!;
      let p: Pt = local.get(id)!;
      for (let tries = 0; tries < 200; tries++) {
        p = { x: Math.cos(t.angle) * r, y: Math.sin(t.angle) * r };
        if (clear([p, ...fanKidsAt(p, t)])) break;
        r += step;
      }
      local.set(id, p);
      placedKids.push(...fanKidsAt(p, t));
    }
    return local;
  };

  const seen = new Set<string>();
  const circles = roots.map((id) => {
    build(id, 0, seen);
    // A root ring starts at the top.
    share(id, -Math.PI / 2, 2 * Math.PI);
    const ids = members(id);
    const local = placeLocal(ids, ringsOf(ids));
    const reach = Math.max(...ids.map((m) => Math.hypot(local.get(m)!.x, local.get(m)!.y) + (trees.get(m)!.fan?.radius ?? 0)));
    return { id, ids, local, x: 0, y: 0, r: reach + claim + (GAP * k) / 2 };
  });
  // packSiblings puts the first circle at the origin: the main agent's
  // constellation, then the largest ones around it, alphabetical on a tie.
  const rank = (c: { id: string }) => (c.id === opts.preferCenter ? 0 : 1);
  circles.sort((a, b) => (rank(a) - rank(b)) || (b.r - a.r) || (a.id < b.id ? -1 : 1));
  packSiblings(circles);
  const first = circles[0];
  const ox = opts.cx - (first?.x ?? 0);
  const oy = opts.cy - (first?.y ?? 0);
  circles.forEach((c) => { c.x += ox; c.y += oy; });
  if (opts.previous?.size) settle(circles, opts.previous);
  for (const c of circles) {
    const cx = c.x;
    const cy = c.y;
    const at = (id: string) => {
      const l = c.local.get(id)!;
      return { x: cx + l.x, y: cy + l.y };
    };
    out.set(c.id, { x: cx, y: cy, root: c.id, parentDistance: null, extent: c.r });
    for (const id of c.ids) {
      const p = at(id);
      const t = trees.get(id)!;
      for (const kid of t.ringKids) {
        const q = at(kid);
        out.set(kid, { ...q, root: c.id, parentDistance: Math.hypot(q.x - p.x, q.y - p.y) });
      }
      if (!t.fan) continue;
      const radius = t.fan.radius;
      fanKidsAt(p, t).forEach((q, i) => out.set(t.kids[i]!, { ...q, root: c.id, parentDistance: radius }));
    }
  }
  return out;
}

/**
 * Keeps every known constellation where it was: unfolding a project must not
 * send its whole group to the other side of the canvas, which a fresh
 * `packSiblings` did whenever the group's new size changed its rank. Known
 * centres are restored, then overlaps are pushed apart — a constellation
 * that grew holds its ground and its neighbours make room; one never seen
 * before (a new agent) keeps its packed spot and moves first.
 */
function settle(circles: Array<{ id: string; x: number; y: number; r: number }>, previous: ReadonlyMap<string, Frame>) {
  const mobility = new Map<string, number>();
  for (const c of circles) {
    const prev = previous.get(c.id);
    if (!prev) { mobility.set(c.id, 3); continue; }
    c.x = prev.x;
    c.y = prev.y;
    mobility.set(c.id, c.r > prev.r + 0.5 ? 0 : 1);
  }
  const ordered = [...circles].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i]!;
        const b = ordered[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const overlap = a.r + b.r - d;
        if (overlap <= 0) continue;
        if (d < 1e-6) { dx = 1; dy = 0; d = 1; }
        let ma = mobility.get(a.id)!;
        let mb = mobility.get(b.id)!;
        if (!ma && !mb) { ma = 1; mb = 1; }
        const push = overlap + 0.5;
        a.x -= (dx / d) * push * (ma / (ma + mb));
        a.y -= (dy / d) * push * (ma / (ma + mb));
        b.x += (dx / d) * push * (mb / (ma + mb));
        b.y += (dy / d) * push * (mb / (ma + mb));
        moved = true;
      }
    }
    if (!moved) break;
  }
}
