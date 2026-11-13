'use client';

/**
 * The island workspace's side of an HTML5 drag (`docs/ISLAND-WORKSPACE.md` §6).
 *
 * During `dragover` the browser hides what a drag carries — only its `types`
 * can be read. So what is being dragged lives HERE, at module level, filled by
 * `startIslandDrag` at `dragstart`; the drag itself only carries a nonce under
 * `application/x-rooks-island`. A drop is accepted when the nonce matches: a
 * drag from another window or application, carrying a forged payload under the
 * same type, is ignored. The params then go through the type's `parseParams`.
 *
 * A source keeps whatever it carried before (`text/agent-name` for the
 * multichat, `text/plain` for the file tree): this only adds a type.
 */

import { useCallback, useSyncExternalStore, type DragEvent as ReactDragEvent } from 'react';
import { useIslandBus } from './island-bus';
import type { IslandDragSource } from './island-drop';
import type { IslandContent } from './island-tree';

/** Lower case: `DataTransfer` lowers it anyway. */
export const ISLAND_DRAG_TYPE = 'application/x-rooks-island';

export type IslandDrag = {
  nonce: string;
  source: IslandDragSource;
  /** What the pill and the announcement call the dragged thing. */
  label: string;
  /** Called once the workspace accepted the drop: a window that held the content closes (§12). */
  onDropped?: () => void;
  /** See `StartIslandDragOptions.hold`. */
  hold?: Element | null;
};

export type StartIslandDragOptions = {
  /** Shown in the announcement; defaults to the registered title of the type. */
  label?: string;
  onDropped?: () => void;
  /**
   * The element the drag starts in, when it has drop targets of its own (the
   * file tree's folders): the workspace's layer only rises while the pointer
   * is outside it, and steps aside again when the pointer comes back.
   */
  hold?: Element | null;
};

type DragLike = Pick<DragEvent, 'dataTransfer'>;

/** Set at `dragstart`, read at `drop`. */
let current: IslandDrag | null = null;
/** What the workspaces show: raised one tick after `dragstart` (see `begin`). */
let raised: IslandDrag | null = null;
let startedAt = 0;
let lastOver = 0;
let counter = 0;
const listeners = new Set<() => void>();

function publish(next: IslandDrag | null): void {
  if (raised === next) return;
  raised = next;
  for (const listener of listeners) listener();
}

/** Not a secret: it only tells our own drag from a forged one. `crypto.randomUUID` is missing on plain http. */
function newNonce(): string {
  counter += 1;
  return `${Date.now().toString(36)}.${counter.toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
}

export function endIslandDrag(): void {
  current = null;
  detachWindowListeners();
  publish(null);
}

// Reset on `dragend` AND `drop`, on `window`: a source that leaves the DOM in
// mid-drag (a moved tab, a closed window) never delivers its `dragend`. The
// reset waits a tick, since a capture listener on `window` runs BEFORE the
// workspace's own `drop` handler, which still needs the state.
const endSoon = () => { window.setTimeout(endIslandDrag, 0); };
const onWindowDragOver = (event: DragEvent) => {
  lastOver = Date.now();
  const hold = current?.hold;
  if (!current || !hold) return;
  // By the rectangle, not the target: once the layer is up, it IS the target.
  const r = hold.getBoundingClientRect();
  const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
  publish(inside ? null : current);
};
// No pointer event fires while a drag runs. One that does means the drag is
// over without either event reaching us (cancelled over another window).
const onWindowPointer = () => {
  const now = Date.now();
  if (current && now - startedAt > 300 && now - lastOver > 300) endIslandDrag();
};
let attached = false;

function attachWindowListeners(): void {
  if (attached || typeof window === 'undefined') return;
  attached = true;
  window.addEventListener('dragend', endSoon, true);
  window.addEventListener('drop', endSoon, true);
  window.addEventListener('dragover', onWindowDragOver, true);
  window.addEventListener('pointermove', onWindowPointer, true);
  window.addEventListener('pointerdown', onWindowPointer, true);
}

function detachWindowListeners(): void {
  if (!attached || typeof window === 'undefined') return;
  attached = false;
  window.removeEventListener('dragend', endSoon, true);
  window.removeEventListener('drop', endSoon, true);
  window.removeEventListener('dragover', onWindowDragOver, true);
  window.removeEventListener('pointermove', onWindowPointer, true);
  window.removeEventListener('pointerdown', onWindowPointer, true);
}

/**
 * Starts a drag of the workspace's own (a tab, an island) or of a content.
 * Sources outside the workspace use `startIslandDrag`.
 */
export function beginIslandDrag(
  event: DragLike,
  source: IslandDragSource,
  label: string,
  onDropped?: () => void,
  hold?: Element | null,
): void {
  const dt = event.dataTransfer;
  if (!dt) return;
  const drag: IslandDrag = { nonce: newNonce(), source, label, onDropped, hold: hold ?? null };
  dt.setData(ISLAND_DRAG_TYPE, drag.nonce);
  // A source that said what it allows keeps it (the file tree moves files).
  if (dt.effectAllowed === 'uninitialized' || dt.effectAllowed === 'all' || !dt.effectAllowed) dt.effectAllowed = 'move';
  current = drag;
  startedAt = Date.now();
  lastOver = startedAt;
  attachWindowListeners();
  // Raised one tick later: a drop layer appearing under the pointer during
  // `dragstart` (an island's tab sits under its own island's layer) makes
  // Chromium abort the drag at once.
  // A held drag rises from the first `dragover` outside its element instead.
  if (!drag.hold) window.setTimeout(() => { if (current === drag) publish(drag); }, 0);
}

/**
 * Drags a content into the workspace of the view on screen (§6). Call it from
 * the source's `onDragStart`, after setting its own types if it has any.
 */
export function startIslandDrag(event: DragLike, content: IslandContent, options: StartIslandDragOptions = {}): void {
  beginIslandDrag(event, { kind: 'content', content }, options.label ?? '', options.onDropped, options.hold);
}

export function carriesIslandDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  return !!dataTransfer?.types && Array.from(dataTransfer.types).includes(ISLAND_DRAG_TYPE);
}

/** The drag being dropped, if the drop carries OUR nonce (§6). */
export function readIslandDrop(dataTransfer: DataTransfer | null | undefined): IslandDrag | null {
  if (!current || !dataTransfer) return null;
  return dataTransfer.getData(ISLAND_DRAG_TYPE) === current.nonce ? current : null;
}

/** The effect to answer: `move` when the source allows it, else what it allows. */
export function dropEffectFor(effectAllowed: string | undefined): 'move' | 'copy' | 'link' {
  const allowed = (effectAllowed ?? 'all').toLowerCase();
  if (allowed === 'all' || allowed === 'uninitialized' || allowed.includes('move')) return 'move';
  if (allowed.includes('copy')) return 'copy';
  return 'link';
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => raised;

/** The drag the workspaces show right now, outside React. */
export function raisedIslandDrag(): IslandDrag | null {
  return raised;
}
const readServer = () => null;

/** The drag in progress, once the layers may rise; `null` otherwise. */
export function useIslandDrag(): IslandDrag | null {
  return useSyncExternalStore(subscribe, read, readServer);
}

export type IslandDragSourceProps = {
  draggable: boolean;
  onDragStart?: (event: ReactDragEvent<HTMLElement>) => void;
};

/**
 * Makes an element a source of `content`: spread the result on it. Nothing to
 * drag while no workspace is announced, or below 768 px (§10: no split there,
 * the "Open in the workspace" action stands in).
 */
export function useIslandDragSource(content: IslandContent | null, options: StartIslandDragOptions = {}): IslandDragSourceProps {
  const bus = useIslandBus();
  const enabled = !!content && bus.present && !bus.narrow;
  const { label, onDropped } = options;
  const onDragStart = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (content) startIslandDrag(event, content, { label, onDropped });
  }, [content, label, onDropped]);
  return enabled ? { draggable: true, onDragStart } : { draggable: false };
}

/**
 * An island moved like a window (`docs/ISLAND-WORKSPACE.md` §12): a pointer
 * gesture, not an HTML5 drag, so nothing above raises a drop layer. What sits
 * above the DOM (Electron's native browser view) still has to step aside.
 */
let windowMoving = false;
const movingListeners = new Set<() => void>();

export function setIslandWindowMoving(next: boolean): void {
  if (windowMoving === next) return;
  windowMoving = next;
  for (const listener of movingListeners) listener();
}

function subscribeMoving(listener: () => void): () => void {
  movingListeners.add(listener);
  return () => movingListeners.delete(listener);
}

/** Whether an island drag OR a window move runs: what covers the page while the pointer travels. */
export function useIslandGesture(): boolean {
  const drag = useIslandDrag();
  const moving = useSyncExternalStore(subscribeMoving, () => windowMoving, () => false);
  return drag !== null || moving;
}

export function resetIslandDragForTests(): void {
  endIslandDrag();
  setIslandWindowMoving(false);
}
