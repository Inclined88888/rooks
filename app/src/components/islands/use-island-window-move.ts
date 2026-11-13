'use client';

/**
 * An island moved by its handle, like a window (`docs/ISLAND-WORKSPACE.md` §12).
 *
 * A pointer gesture, not an HTML5 drag: the island itself follows the pointer.
 * Past a few pixels a docked island becomes a popup, then nothing is drawn
 * while it travels: no target under the pointer, no preview. Only a pointer
 * pressed against the screen's border shows where the window would dock, and
 * only then does releasing it dock it. Released anywhere else, it stays a
 * popup where it is.
 *
 * An island that cannot be a popup (the route's own, or one popup too many)
 * moves as an outline instead: the same edges dock it, the middle of the page
 * leaves it where it was.
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { setIslandWindowMoving } from '@/lib/island-drag';
import { planIslandDrop, sameDropTarget, windowSnapEdgesAt, windowSnapTargetAt, type IslandDropTarget, type ResolvedContent } from '@/lib/island-drop';
import {
  clampFloatRect,
  floatLeaf,
  floatOf,
  type IslandContent,
  type IslandLayout,
  type IslandResult,
  type IslandTree,
  type Rect,
} from '@/lib/island-tree';

/** The pointer must travel this far before a press on the handle becomes a move: a click stays a click. */
export const WINDOW_MOVE_THRESHOLD = 4;
/** A docked island torn off keeps its size, up to these fractions of the workspace. */
const TORN_MAX_WIDTH = 0.6;
const TORN_MAX_HEIGHT = 0.7;

export type IslandWindowMove = {
  leafId: string;
  /**
   * Where the window docks on release, drawn: the whole workspace or one
   * column (or row) along the screen's edge the pointer presses against.
   * `null` = it stays where it is.
   */
  target: IslandDropTarget | null;
  /** The outline of an island that moves without becoming a popup, in the workspace's coordinates. */
  outline: Rect | null;
  /**
   * How far the pointer took the popup past the workspace, in pixels. The tree
   * keeps it inside (`clampFloatRect`); the popup is painted shifted by this,
   * so it keeps following the pointer up to the screen's border, and settles
   * back inside on release.
   */
  shift: { x: number; y: number } | null;
};

type Box = Rect;

export function useIslandWindowMove({
  container,
  treeRef,
  layoutRef,
  box,
  apply,
  resolve,
  onDocked,
}: {
  container: RefObject<HTMLDivElement | null>;
  treeRef: { readonly current: IslandTree };
  layoutRef: { readonly current: IslandLayout | null };
  box: Box;
  apply: (op: (current: IslandTree) => IslandResult, persist?: boolean, force?: boolean) => IslandResult;
  resolve: (content: IslandContent) => ResolvedContent | null;
  /** Told once a move docked the island. */
  onDocked: (leafId: string, target: IslandDropTarget) => void;
}): { state: IslandWindowMove | null; start: (e: ReactPointerEvent<HTMLElement>, leafId: string) => void } {
  const [state, setState] = useState<IslandWindowMove | null>(null);
  const boxRef = useRef(box);
  boxRef.current = box;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  const onDockedRef = useRef(onDocked);
  onDockedRef.current = onDocked;
  const cleanup = useRef<(() => void) | null>(null);
  // Unmounted in mid-move: the listeners go, and whatever sits above the DOM comes back.
  useEffect(() => () => { cleanup.current?.(); }, []);

  const start = useCallback((e: ReactPointerEvent<HTMLElement>, leafId: string) => {
    if (e.button !== 0) return;
    // A press on a button of the header (close, ⋯, a tab) is not the start of a move.
    if ((e.target as Element).closest('button, a, input, [role="tab"]')) return;
    const layout = layoutRef.current;
    const placed = layout?.islands[leafId];
    const frame = container.current;
    if (!placed || !frame) return;
    e.preventDefault();
    cleanup.current?.();
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    const startTree = treeRef.current;
    const origin = frame.getBoundingClientRect();
    const b = boxRef.current;
    const popup = floatOf(startTree, leafId);
    // Checked once, before anything moves: a gesture never leaves a half-applied tree.
    const floats = !floatLeaf(startTree, leafId, popup?.rect ?? { x: 0, y: 0, width: 0.5, height: 0.5 }).refused;
    const width = popup || !floats ? placed.width : Math.min(placed.width, b.width * TORN_MAX_WIDTH);
    const height = popup || !floats ? placed.height : Math.min(placed.height, b.height * TORN_MAX_HEIGHT);
    // The point of the header under the pointer stays under it, scaled with a narrower window.
    const grabX = (e.clientX - origin.left - placed.x) * (width / Math.max(1, placed.width));
    const grabY = Math.min(e.clientY - origin.top - placed.y, height);
    const from = { x: e.clientX, y: e.clientY };
    let started = false;
    let target: IslandDropTarget | null = null;

    const accepted = (t: IslandDropTarget) => !planIslandDrop(treeRef.current, { kind: 'island', islandId: leafId }, t, resolveRef.current).refused;
    const targetAt = (x: number, y: number): IslandDropTarget | null => {
      const edges = windowSnapEdgesAt(x, y, { width: window.innerWidth, height: window.innerHeight });
      const layout = layoutRef.current;
      if (!edges.length || !layout) return null;
      const popups = new Set((treeRef.current.floats ?? []).map((f) => f.leaf.id));
      popups.add(leafId);
      const picked = edges
        .map((edge) => windowSnapTargetAt(layout, boxRef.current, edge, edge === 'top' || edge === 'bottom' ? x - origin.left : y - origin.top, popups))
        .filter(accepted);
      // In a corner, the column (or row) under the pointer wins over the whole workspace.
      const island = picked.find((target) => target.kind === 'island');
      if (island) return island;
      if (picked[0]) return picked[0];
      // One column too deep, say: the whole workspace still takes it.
      const root: IslandDropTarget = { kind: 'root', edge: edges[0]! };
      return accepted(root) ? root : null;
    };
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < WINDOW_MOVE_THRESHOLD) return;
        started = true;
        setIslandWindowMoving(true);
      }
      const box = boxRef.current;
      if (box.width <= 0 || box.height <= 0) return;
      const left = ev.clientX - origin.left - grabX;
      const top = ev.clientY - origin.top - grabY;
      let outline: Rect | null = null;
      let shift: { x: number; y: number } | null = null;
      if (floats) {
        const rect = { x: (left - box.x) / box.width, y: (top - box.y) / box.height, width: width / box.width, height: height / box.height };
        applyRef.current((tr) => floatLeaf(tr, leafId, rect), false);
        const kept = clampFloatRect(rect);
        const x = Math.round(left - (box.x + kept.x * box.width));
        const y = Math.round(top - (box.y + kept.y * box.height));
        shift = x !== 0 || y !== 0 ? { x, y } : null;
      } else {
        outline = { x: left, y: top, width, height };
      }
      target = targetAt(ev.clientX, ev.clientY);
      const next = target;
      setState((old) => (old && sameDropTarget(old.target, next) && !outline && !old.outline && sameShift(old.shift, shift)
        ? old
        : { leafId, target: next, outline, shift }));
    };
    const finish = (commit: boolean) => {
      cleanup.current?.();
      if (!started) return;
      if (!commit) {
        applyRef.current(() => ({ tree: startTree, refused: null }), true, true);
        return;
      }
      if (target) {
        const plan = planIslandDrop(treeRef.current, { kind: 'island', islandId: leafId }, target, resolveRef.current);
        if (!plan.refused) {
          applyRef.current(() => ({ tree: plan.tree, refused: null }));
          onDockedRef.current(leafId, target);
          return;
        }
      }
      // Left where it is: written once, now that the gesture is over.
      if (floats) applyRef.current((tr) => ({ tree: tr, refused: null }), true, true);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    cleanup.current = () => {
      cleanup.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      if (handle.isConnected && handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      setIslandWindowMoving(false);
      setState(null);
    };
  }, [container, treeRef, layoutRef]);

  return { state, start };
}

function sameShift(a: { x: number; y: number } | null, b: { x: number; y: number } | null): boolean {
  return a === b || (!!a && !!b && a.x === b.x && a.y === b.y);
}
