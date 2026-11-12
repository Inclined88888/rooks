/**
 * The layout of the Git widget's commit graph (TODO #278, volet 3).
 *
 * Pure: commits in, lanes and edges out, so the SVG only draws. The log comes
 * children before parents (`--date-order`), which is all a lane assignment
 * needs: one pass, each lane waiting for the sha of the next commit it leads
 * to. No library (AGENTS.md rule 12) and no history editing — a commit is read,
 * never moved.
 *
 * Each row is cut in two halves around its node: `top` edges run from the top
 * of the row to the middle, `bottom` edges from the middle to the bottom. A
 * lane passing by draws one straight edge in each half; a lane ending on the
 * node, or leaving it towards a parent, bends in its half.
 */

import type { GitCommit, GitWorktree } from './git-store';

export type GraphEdge = {
  half: 'top' | 'bottom';
  from: number;
  to: number;
  color: number;
};

export type GraphRow = {
  commit: GitCommit;
  lane: number;
  color: number;
  edges: GraphEdge[];
};

export type GraphLayout = {
  rows: GraphRow[];
  /** Widest the graph gets, in lanes. */
  lanes: number;
};

type Slot = { sha: string; color: number } | null;

function firstFree(slots: Slot[]): number {
  const i = slots.indexOf(null);
  return i === -1 ? slots.length : i;
}

export function layoutGraph(commits: readonly GitCommit[]): GraphLayout {
  let slots: Slot[] = [];
  let nextColor = 0;
  let lanes = 0;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = slots;
    slots = before.slice();
    const edges: GraphEdge[] = [];

    let lane = before.findIndex((s) => s?.sha === commit.hash);
    let color: number;
    if (lane === -1) {
      // A tip: no child read so far leads here.
      lane = firstFree(slots);
      color = nextColor++;
    } else {
      color = before[lane]!.color;
    }

    before.forEach((s, j) => {
      if (!s) return;
      // Every lane waiting for this commit converges on its node; the others
      // pass by.
      edges.push(s.sha === commit.hash
        ? { half: 'top', from: j, to: lane, color: s.color }
        : { half: 'top', from: j, to: j, color: s.color });
      if (s.sha === commit.hash) slots[j] = null;
    });

    // A passing lane that hands its parent over to this commit's lane bends
    // into it below the node instead of going straight down.
    const handedOver = new Map<number, number>();
    const [first, ...merged] = commit.parents;
    if (first) {
      // A sibling already leads to this parent (a fork point further down):
      // one lane for one commit. The leftmost keeps it, so the line a branch
      // forked from stays straight and the branch is the one that bends.
      const shared = slots.findIndex((s) => s?.sha === first);
      if (shared !== -1 && shared < lane) {
        edges.push({ half: 'bottom', from: lane, to: shared, color });
      } else {
        if (shared !== -1) {
          handedOver.set(shared, lane);
          slots[shared] = null;
        }
        slots[lane] = { sha: first, color };
        edges.push({ half: 'bottom', from: lane, to: lane, color });
      }
    }
    for (const parent of merged) {
      const shared = slots.findIndex((s) => s?.sha === parent);
      if (shared !== -1) {
        edges.push({ half: 'bottom', from: lane, to: shared, color: slots[shared]!.color });
        continue;
      }
      const k = firstFree(slots);
      const c = nextColor++;
      slots[k] = { sha: parent, color: c };
      edges.push({ half: 'bottom', from: lane, to: k, color: c });
    }

    // The lanes that only passed by go on below the node.
    before.forEach((s, j) => {
      if (!s || s.sha === commit.hash) return;
      const into = handedOver.get(j);
      if (into !== undefined) edges.push({ half: 'bottom', from: j, to: into, color: s.color });
      else if (slots[j] === s) edges.push({ half: 'bottom', from: j, to: j, color: s.color });
    });

    while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop();
    lanes = Math.max(lanes, before.length, slots.length, lane + 1);
    rows.push({ commit, lane, color, edges });
  }

  return { rows, lanes };
}

/** What a row says about the refs on its commit. */
export type GraphPill =
  | { kind: 'branch'; name: string; current: boolean; synced: boolean; worktree: string | null }
  | { kind: 'remote'; name: string }
  | { kind: 'tag'; name: string }
  | { kind: 'head' }
  | { kind: 'worktree'; name: string; path: string };

/** The last segment of a path written by git on any OS (`C:/…` or `C:\…`). */
export function pathTail(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * The pills of one commit, current branch first.
 *
 * A remote branch on the same commit as its local twin is folded into it
 * (`synced`): two pills saying one thing would push the subject out of a
 * narrow rail. A branch checked out by another worktree is "occupied", and a
 * worktree on a detached HEAD — an agent's task, most of the time — gets a
 * pill of its own, since no branch name would show it.
 */
export function pillsFor(
  commit: GitCommit,
  worktrees: readonly GitWorktree[],
  currentBranch: string | null,
): GraphPill[] {
  const locals = commit.refs.filter((r) => r.kind === 'branch').map((r) => r.name);
  const remotes = commit.refs.filter((r) => r.kind === 'remote').map((r) => r.name);
  const headHere = commit.refs.some((r) => r.kind === 'head');
  const folded = new Set<string>();
  const pills: GraphPill[] = [];

  for (const name of locals) {
    const twin = remotes.find((r) => r.slice(r.indexOf('/') + 1) === name);
    if (twin) folded.add(twin);
    const holder = worktrees.find((w) => w.branch === name && !w.current);
    pills.push({
      kind: 'branch',
      name,
      current: headHere && name === currentBranch,
      synced: !!twin,
      worktree: holder ? holder.path : null,
    });
  }
  pills.sort((a, b) => Number(b.kind === 'branch' && b.current) - Number(a.kind === 'branch' && a.current));

  // HEAD with no branch of its own: the project checkout is detached here.
  if (headHere && !pills.some((p) => p.kind === 'branch' && p.current)) pills.unshift({ kind: 'head' });

  for (const w of worktrees) {
    if (!w.current && w.detached && w.head === commit.hash) {
      pills.push({ kind: 'worktree', name: pathTail(w.path), path: w.path });
    }
  }
  for (const name of remotes) if (!folded.has(name)) pills.push({ kind: 'remote', name });
  for (const r of commit.refs) if (r.kind === 'tag') pills.push({ kind: 'tag', name: r.name });
  return pills;
}
