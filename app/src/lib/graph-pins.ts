/**
 * Nodes the user moved by hand on the Agents graph. What is stored is the
 * offset from the node's computed place, not a position: it stays right when
 * the group moves, a project unfolds or the window is resized.
 *
 * Offsets compose down the hierarchy: a node's target is its seed plus the
 * offsets of all its ancestors plus its own. Moving a hub therefore moves its
 * whole sub-tree, folded or hidden parts included, and a child pinned under it
 * keeps its place relative to the hub.
 */

import type { ForceX, ForceY, Simulation, SimulationNodeDatum } from 'd3';

export type Offset = { dx: number; dy: number };

export const PINS_STORAGE_KEY = 'rooks:agents-pins';

/** Below this, a release is a click, not a move. */
export const PIN_MIN_MOVE = 4;

/** Reads the stored offsets, dropping anything that is not a finite pair. */
export function parsePins(raw: string | null): Map<string, Offset> {
  if (!raw) return new Map();
  try {
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return new Map();
    const out = new Map<string, Offset>();
    for (const [id, v] of Object.entries(obj)) {
      if (!v || typeof v !== 'object') continue;
      const { dx, dy } = v as Record<string, unknown>;
      if (typeof dx === 'number' && typeof dy === 'number' && Number.isFinite(dx) && Number.isFinite(dy)) out.set(id, { dx, dy });
    }
    return out;
  } catch {
    return new Map();
  }
}

export function serializePins(pins: ReadonlyMap<string, Offset>): string | null {
  return pins.size ? JSON.stringify(Object.fromEntries(pins)) : null;
}

export type TreeLink = { source: string; target: string };

/** One parent per node, the first incoming link winning (as in layoutForest). */
export function parentsOf(links: readonly TreeLink[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of links) {
    if (l.source === l.target || out.has(l.target)) continue;
    out.set(l.target, l.source);
  }
  return out;
}

/** Sum of the ancestors' offsets. A `reports_to` cycle is walked once. */
export function inheritedOffset(id: string, parentOf: ReadonlyMap<string, string>, pins: ReadonlyMap<string, Offset>): Offset {
  let dx = 0;
  let dy = 0;
  const seen = new Set([id]);
  for (let p = parentOf.get(id); p != null && !seen.has(p); p = parentOf.get(p)) {
    seen.add(p);
    const o = pins.get(p);
    if (o) { dx += o.dx; dy += o.dy; }
  }
  return { dx, dy };
}

/** Where a node goes relative to its seed: inherited offsets plus its own. */
export function totalOffset(id: string, parentOf: ReadonlyMap<string, string>, pins: ReadonlyMap<string, Offset>): Offset {
  const up = inheritedOffset(id, parentOf, pins);
  const own = pins.get(id);
  return { dx: up.dx + (own?.dx ?? 0), dy: up.dy + (own?.dy ?? 0) };
}

/** The node's own offset once released at (x, y). */
export function ownOffsetAt(
  x: number,
  y: number,
  seed: { x: number; y: number },
  inherited: Offset,
): Offset {
  return { dx: x - seed.x - inherited.dx, dy: y - seed.y - inherited.dy };
}

/** Every node below `id`, cycle-safe, `id` itself excluded. */
export function descendantsOf(id: string, parentOf: ReadonlyMap<string, string>): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of parentOf) {
    const list = childrenOf.get(parent) ?? [];
    list.push(child);
    childrenOf.set(parent, list);
  }
  const out = new Set<string>();
  const stack = [...(childrenOf.get(id) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    if (c === id || out.has(c)) continue;
    out.add(c);
    stack.push(...(childrenOf.get(c) ?? []));
  }
  return out;
}

/**
 * Points the 'anchorX'/'anchorY' forces at the nodes' current targets.
 * d3's forceX/forceY copy each target once, in initialize(): changing a
 * node's target afterwards goes unseen until the accessor is set again (or
 * sim.nodes() is called), and a moved group springs back to its old place.
 */
export function reaimAnchors<N extends SimulationNodeDatum>(
  sim: Simulation<N, undefined>,
  x: (n: N) => number,
  y: (n: N) => number,
): void {
  sim.force<ForceX<N>>('anchorX')?.x(x);
  sim.force<ForceY<N>>('anchorY')?.y(y);
}
