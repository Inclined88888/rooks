/**
 * Folding of the agents graph: a folded node hides everything below it and
 * shows how many agents it hides. By default only the orchestrators show —
 * the main agent and the pole hubs stay open, every other agent with
 * sub-agents (a project's lead) is folded. The user's choices are stored as
 * overrides of that default, so a new project arrives folded.
 */

export type FoldLink = { source: string; target: string };

export type FoldView = {
  /** Nodes hidden under a folded ancestor. */
  hidden: Set<string>;
  /** Folded node → number of agents it hides (absent when it hides none). */
  hiddenBelow: Map<string, number>;
  /** Nodes that have at least one child, visible or not. */
  parents: Set<string>;
  /** Hidden node → the visible folded ancestor that hides it. */
  hiddenOwner: Map<string, string>;
};

export const FOLD_STORAGE_KEY = 'rooks:agents-fold';

export function foldView(
  ids: readonly string[],
  links: readonly FoldLink[],
  isFolded: (id: string) => boolean,
): FoldView {
  const known = new Set(ids);
  const childrenOf = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const l of links) {
    if (l.source === l.target || !known.has(l.source) || !known.has(l.target)) continue;
    // One parent per node, as in the layout.
    if (hasParent.has(l.target)) continue;
    hasParent.add(l.target);
    const list = childrenOf.get(l.source) ?? [];
    list.push(l.target);
    childrenOf.set(l.source, list);
  }

  const hidden = new Set<string>();
  const hiddenBelow = new Map<string, number>();
  const below = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set([id]);
    const stack = [...(childrenOf.get(id) ?? [])];
    while (stack.length) {
      const c = stack.pop()!;
      // A reports_to cycle must not loop.
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      stack.push(...(childrenOf.get(c) ?? []));
    }
    return out;
  };
  const underOf = new Map<string, string[]>();
  for (const id of childrenOf.keys()) {
    if (!isFolded(id)) continue;
    const under = below(id);
    under.forEach((c) => hidden.add(c));
    underOf.set(id, under);
  }
  const hiddenOwner = new Map<string, string>();
  // A folded node that is itself hidden shows no count, and owns nothing:
  // its agents answer to the visible ancestor that hides them all.
  for (const [id, under] of underOf) {
    if (hidden.has(id)) continue;
    hiddenBelow.set(id, under.length);
    under.forEach((c) => hiddenOwner.set(c, id));
  }
  return { hidden, hiddenBelow, parents: new Set(childrenOf.keys()), hiddenOwner };
}

/**
 * Folded nodes that hide any of `reveal`, ancestors included: opening them
 * all makes the agents visible. An agent created while its lead is folded
 * (the default for every project) would otherwise be saved yet nowhere on
 * screen.
 */
export function foldsHiding(
  reveal: readonly string[],
  links: readonly FoldLink[],
  isFolded: (id: string) => boolean,
): string[] {
  const parentOf = new Map<string, string>();
  for (const l of links) {
    if (l.source === l.target || parentOf.has(l.target)) continue;
    parentOf.set(l.target, l.source);
  }
  const out = new Set<string>();
  for (const id of reveal) {
    const seen = new Set([id]);
    let cur = parentOf.get(id);
    // A reports_to cycle must not loop.
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (isFolded(cur)) out.add(cur);
      cur = parentOf.get(cur);
    }
  }
  return [...out];
}

export type AgentLiveState = 'needs_action' | 'thinking' | 'done' | 'idle';

const STATE_RANK: Record<AgentLiveState, number> = { needs_action: 3, thinking: 2, done: 1, idle: 0 };

const isLiveState = (s: string): s is AgentLiveState => s in STATE_RANK;

/**
 * State to show on each visible node: its own, raised by the busiest agent a
 * fold hides under it. A hidden idle agent never dims its folded ancestor.
 */
export function foldedStates(
  states: ReadonlyMap<string, string>,
  hiddenOwner: ReadonlyMap<string, string>,
): Map<string, AgentLiveState> {
  const out = new Map<string, AgentLiveState>();
  for (const [id, s] of states) {
    if (!isLiveState(s)) continue;
    const owner = hiddenOwner.get(id);
    if (owner && s === 'idle') continue;
    const target = owner ?? id;
    const cur = out.get(target);
    if (!cur || STATE_RANK[s] > STATE_RANK[cur]) out.set(target, s);
  }
  return out;
}

/** Reads the user's overrides, tolerating a missing or corrupted entry. */
export function parseFoldOverrides(raw: string | null): Map<string, boolean> {
  if (!raw) return new Map();
  try {
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return new Map();
    return new Map(Object.entries(obj).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'));
  } catch {
    return new Map();
  }
}

/** Flips a node and drops the override when it lands back on the default. */
export function toggleFold(overrides: Map<string, boolean>, id: string, folded: boolean, byDefault: boolean): Map<string, boolean> {
  const next = new Map(overrides);
  if (!folded === byDefault) next.delete(id);
  else next.set(id, !folded);
  return next;
}
