'use client';

/**
 * The drop layer of the island workspace (`docs/ISLAND-WORKSPACE.md` §9), in
 * the spirit of the multichat's `slot-drop-zone.tsx`: while an island drag
 * runs, ONE layer covers the whole workspace. The pointer then only touches
 * it — an iframe, a terminal's canvas or a composer can no longer swallow the
 * events — and the island under the pointer is found from the layout, not
 * from the DOM. Its children (preview, pill) never take the pointer, so it
 * needs no enter/leave counting.
 *
 * Split, the layer sits in the workspace's own (positioned) container. Alone,
 * the workspace has no box to lean on — the chat's is `display: contents` —
 * so the layer is portalled to `<body>`, `fixed` over the frame's rectangle.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactElement, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { carriesIslandDrag, dropEffectFor, readIslandDrop, type IslandDrag } from '@/lib/island-drag';
import {
  ROOT_DROP_BAND,
  dropLabelKey,
  dropPreviewRect,
  islandDropTargetAt,
  planIslandDrop,
  rootPreviewRect,
  sameDropTarget,
  tabInsertIndex,
  type IslandDropRefusal,
  type IslandDropTarget,
  type ResolvedContent,
} from '@/lib/island-drop';
import { collectLeaves, floatRectAt, type IslandContent, type IslandLayout, type IslandTree, type Rect } from '@/lib/island-tree';

type Box = Rect & { gap: number };

type Hover = {
  target: IslandDropTarget;
  refused: IslandDropRefusal | null;
  /** Where the ghost tab sits in the tab bar, for a drop among the tabs. */
  ghost: Rect | null;
};

/** Width of the ghost tab shown at the insertion place (§9). */
const GHOST_PX = 40;

const rectStyle = (rect: Rect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });

/**
 * The rectangle of a frame on screen. An element in `display: contents` has
 * none of its own: the union of its children's stands in for it.
 */
type ScreenRect = { left: number; top: number; width: number; height: number };

function frameRect(el: Element): ScreenRect | null {
  const own = el.getBoundingClientRect();
  if (own.width > 0 && own.height > 0) return own;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const child of Array.from(el.children)) {
    const r = frameRect(child);
    if (!r) continue;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.left + r.width);
    bottom = Math.max(bottom, r.top + r.height);
  }
  if (!Number.isFinite(left)) return null;
  return { left, top, width: right - left, height: bottom - top };
}

export function IslandDropLayer({
  drag,
  tree,
  layout,
  box,
  frame,
  headerPx,
  resolve,
  leafTitle,
  onDrop,
}: {
  drag: IslandDrag;
  tree: IslandTree;
  /** The islands on screen; `null` while the workspace is one frame, nothing painted. */
  layout: IslandLayout | null;
  box: Box;
  frame: RefObject<HTMLDivElement | null>;
  headerPx: number;
  resolve: (content: IslandContent) => ResolvedContent | null;
  leafTitle: (leafId: string) => string;
  onDrop: (drag: IslandDrag, target: IslandDropTarget) => void;
}): ReactElement | null {
  const layer = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const split = layout !== null;
  const [fixedRect, setFixedRect] = useState<Rect | null>(null);

  useLayoutEffect(() => {
    if (split) return;
    const read = () => {
      const el = frame.current;
      // A frame without a box: the page's own wrapper, not every child of the
      // frame (the announcer is a 1 px box at its static place).
      const own = el?.getBoundingClientRect();
      const source = el && own && own.width > 0 && own.height > 0
        ? el
        : el?.querySelector('[data-island-tab="host:route"]') ?? el;
      const r = source ? frameRect(source) : null;
      if (!r) { setFixedRect(null); return; }
      // A page that paints edge to edge (the chat) reaches under the nav rail
      // and the top bar, which are no place to drop: the layer stops at them.
      const root = getComputedStyle(document.documentElement);
      const px = (name: string) => { const v = parseFloat(root.getPropertyValue(name)); return Number.isFinite(v) && v > 0 ? v : 0; };
      const left = Math.max(r.left, px('--timon-nav-w'));
      const top = Math.max(r.top, px('--timon-topbar-h'));
      setFixedRect({ x: left, y: top, width: Math.max(0, r.left + r.width - left), height: Math.max(0, r.top + r.height - top) });
    };
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, [split, frame]);

  // Alone, the frame is one island with neither header nor edge bands: they
  // would say the same as its own edges.
  const singleId = collectLeaves(tree.root)[0]!.id;
  const localBox: Rect = split ? box : { x: 0, y: 0, width: fixedRect?.width ?? 0, height: fixedRect?.height ?? 0 };
  const localLayout: IslandLayout = split ? layout : { islands: { [singleId]: localBox }, gutters: [] };

  /** The tabs of an island's bar, in the layer's coordinates. */
  const handlesOf = (islandId: string, origin: ScreenRect) => {
    const chassis = frame.current?.querySelector(`[data-island="${islandId}"]`);
    if (!chassis) return [];
    return Array.from(chassis.querySelectorAll<HTMLElement>('[data-island-tab-handle]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.islandTabHandle ?? '', left: r.left - origin.left, width: r.width };
    });
  };

  const locate = (e: DragEvent): { target: IslandDropTarget | null; ghost: Rect | null } => {
    const origin = (layer.current ?? e.currentTarget).getBoundingClientRect();
    const x = e.clientX - origin.left;
    const y = e.clientY - origin.top;
    const dragged = drag.source.kind === 'tab' ? drag.source.tabId : undefined;
    const inside = x >= localBox.x && y >= localBox.y && x <= localBox.x + localBox.width && y <= localBox.y + localBox.height;
    // Alt: wherever the pointer is, a popup of its own (`docs/ISLAND-WORKSPACE.md` §12).
    if (e.altKey && inside && localBox.width > 0 && localBox.height > 0) {
      const rect = floatRectAt((x - localBox.x) / localBox.width, (y - localBox.y) / localBox.height);
      return { target: { kind: 'float', rect }, ghost: null };
    }
    const target = islandDropTargetAt(localLayout, localBox, x, y, {
      headerPx: split ? headerPx : 0,
      rootBand: split ? ROOT_DROP_BAND : 0,
      tabIndexAt: (islandId, px) => tabInsertIndex(handlesOf(islandId, origin), px, dragged),
      floatIds: new Set((tree.floats ?? []).map((f) => f.leaf.id)),
    });
    let ghost: Rect | null = null;
    if (target?.kind === 'island' && target.index !== undefined) {
      const rect = localLayout.islands[target.islandId]!;
      const handles = handlesOf(target.islandId, origin).filter((h) => h.id !== dragged);
      const after = handles[target.index - 1];
      const at = handles[target.index];
      const left = at ? at.left - GHOST_PX / 2 : after ? after.left + after.width + 4 : rect.x + 8;
      ghost = { x: Math.max(rect.x, left), y: rect.y + 6, width: GHOST_PX, height: headerPx - 12 };
    }
    return { target, ghost };
  };

  const onDragOver = (e: DragEvent) => {
    if (!carriesIslandDrag(e.dataTransfer)) return;
    e.preventDefault();
    const { target, ghost } = locate(e);
    const refused = target ? planIslandDrop(tree, drag.source, target, resolve).refused : null;
    e.dataTransfer.dropEffect = !target || refused ? 'none' : dropEffectFor(e.dataTransfer.effectAllowed);
    // `dragover` fires every few dozen milliseconds: only a new target re-renders.
    setHover((old) => {
      if (!target) return null;
      if (old && sameDropTarget(old.target, target) && old.refused === refused) return old;
      return { target, refused, ghost };
    });
  };

  const onDragLeave = (e: DragEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && layer.current?.contains(next)) return;
    setHover(null);
  };

  const onDropEvent = (e: DragEvent) => {
    const accepted = readIslandDrop(e.dataTransfer);
    if (!accepted) return;
    e.preventDefault();
    const { target } = locate(e);
    setHover(null);
    if (target) onDrop(accepted, target);
  };

  const body = (
    <div
      ref={layer}
      data-island-drop-layer=""
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDropEvent}
      className={split ? 'absolute inset-0 z-40' : 'fixed z-40'}
      style={split ? undefined : fixedRect ? rectStyle(fixedRect) : { display: 'none' }}
    >
      {hover && (
        <IslandDropPreview
          tree={tree}
          target={hover.target}
          refused={hover.refused}
          ghost={hover.ghost}
          layout={localLayout}
          box={localBox}
          headerPx={split ? headerPx : 0}
          leafTitle={leafTitle}
        />
      )}
    </div>
  );
  if (split) return body;
  return typeof document === 'undefined' ? null : createPortal(body, document.body);
}

/**
 * What a drop would do, drawn over the workspace: the place the content would
 * take, the ghost tab in the bar, the pill that says it (or why not). Shared
 * by the pointer's layer and the keyboard's "Move…" mode (§11): the same
 * target draws the same preview.
 */
export function IslandDropPreview({
  tree,
  target,
  refused,
  ghost = null,
  layout,
  box,
  headerPx,
  leafTitle,
}: {
  tree: IslandTree;
  target: IslandDropTarget;
  refused: IslandDropRefusal | null;
  ghost?: Rect | null;
  layout: IslandLayout;
  box: Rect;
  /** 0 while the workspace is one frame: no header to leave out. */
  headerPx: number;
  leafTitle: (leafId: string) => string;
}): ReactElement {
  const islandRect = target.kind === 'island' ? layout.islands[target.islandId] : undefined;
  let preview: Rect | null = null;
  let pillAt: Rect | null;
  let label: string;
  if (refused) {
    label = t(`islands.refused.${refused}`);
    pillAt = islandRect ?? box;
  } else {
    preview = target.kind === 'root'
      ? rootPreviewRect(tree, box, target.edge)
      : target.kind === 'float'
        ? {
          x: box.x + target.rect.x * box.width,
          y: box.y + target.rect.y * box.height,
          width: target.rect.width * box.width,
          height: target.rect.height * box.height,
        }
        : islandRect ? dropPreviewRect(islandRect, target.region, headerPx) : null;
    pillAt = preview;
    label = t(dropLabelKey(target), { target: target.kind === 'island' ? leafTitle(target.islandId) : '' });
  }
  return (
    <>
      {preview && (
        <div
          data-island-drop-preview={target.kind === 'root' ? `root:${target.edge}` : target.kind === 'float' ? 'float' : target.region}
          // Frosted, not see-through: what lies under the place stays readable as a shape, not as text.
          className="pointer-events-none absolute rounded-[var(--timon-island-radius)] bg-primary/15 shadow-elev-2 ring-2 ring-inset ring-primary/70 backdrop-blur-md transition-all duration-100"
          style={rectStyle(preview)}
        />
      )}
      {ghost && !refused && (
        <div className="pointer-events-none absolute rounded-md bg-primary/25 ring-1 ring-inset ring-primary" style={rectStyle(ghost)} />
      )}
      {pillAt && label && (
        <div className="pointer-events-none absolute grid place-items-center" style={rectStyle(pillAt)}>
          <span
            data-island-drop-label=""
            className={cn(
              'max-w-[80%] truncate rounded-full bg-popover/95 px-3 py-1 text-xs font-medium shadow-elev-2 backdrop-blur-sm',
              refused ? 'text-muted-foreground' : 'text-primary ring-1 ring-primary/40',
            )}
          >
            {label}
          </span>
        </div>
      )}
    </>
  );
}
