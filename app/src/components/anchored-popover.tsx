'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { placePopover, placeSheet, wantsSheet, type PopoverAlign, type PopoverPlacement, type PopoverPosition, type Viewport } from '@/lib/popover-placement';
import { NativeViewCover } from '@/lib/native-view-cover';

/**
 * A panel anchored to a button, kept inside the window — the bell's dropdown
 * and the quota rings' detail, wherever their widget stands.
 *
 * Hand-rolled rather than a Radix menu: a menu traps Tab, and these panels
 * hold ordinary links and buttons that must stay reachable from the keyboard.
 * Portaled to the body, so neither the top bar's mobile fold nor a rail's
 * `overflow` can clip it.
 *
 * Controlled: the caller owns `open` and toggles it from the anchor's click.
 * Escape closes and gives the focus back to the anchor; a press outside the
 * panel AND the anchor closes (the anchor is left out so its own click can
 * toggle). Repositioned on resize and on any scroll — a rail scrolls its
 * widgets under a fixed panel. Nothing touches `document` while closed.
 *
 * Placed in the VISUAL viewport: a phone's soft keyboard shrinks only that
 * one (iOS keeps `innerHeight` and scrolls the page under fixed boxes), so
 * the panel lives in a box pinned on `visualViewport` and follows its
 * resize and scroll.
 *
 * Part of `@rooks/ui`: a frozen contract, props can be added, never removed.
 */
export function AnchoredPopover({
  open,
  onClose,
  anchorRef,
  placement = 'below',
  align = 'end',
  width = 352,
  maxHeight = 512,
  label,
  id,
  className,
  sheet = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** `below` (a line, the top bar) or `beside` (a column). */
  placement?: PopoverPlacement;
  /** `below` only: `end` lines the right edges up (default), `start` the left ones. */
  align?: PopoverAlign;
  /** Preferred width in px; a narrower window gets the window minus 16px. */
  width?: number;
  /** Height ceiling in px; the space left on screen lowers it further. */
  maxHeight?: number;
  /** Accessible name of the dialog. */
  label?: string;
  id?: string;
  className?: string;
  /**
   * On a touch-first or phone-wide screen (`wantsSheet`), open as a sheet
   * across the foot of the visible area — above the soft keyboard when it is
   * open — instead of next to the anchor. For a panel with a field to type in.
   */
  sheet?: boolean;
  children?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  const [area, setArea] = useState<Required<Viewport> | null>(null);
  // The latest `onClose` without re-subscribing the listeners on every render
  // of a caller that passes an inline arrow.
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });

  useLayoutEffect(() => {
    if (!open) { setPos(null); setArea(null); return; }
    const vv = window.visualViewport;
    const place = (e?: Event) => {
      // The panel's own list scrolling does not move its anchor.
      if (e?.target instanceof Node && panel.current?.contains(e.target)) return;
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const visible: Required<Viewport> = vv
        ? { top: vv.offsetTop, left: vv.offsetLeft, width: vv.width, height: vv.height }
        : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
      setArea(visible);
      setPos(sheet && wantsSheet(visible, coarsePointer())
        ? placeSheet(visible, { maxHeight })
        : placePopover(anchor, visible, { placement, align, width, maxHeight }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
    };
  }, [open, anchorRef, placement, align, width, maxHeight, sheet]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      anchorRef.current?.focus();
      close.current();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || anchorRef.current?.contains(target)) return;
      close.current();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open, anchorRef]);

  if (!open || !pos || !area) return null;
  const style: CSSProperties = { left: pos.left, width: pos.width, maxHeight: pos.maxHeight };
  if (pos.top !== undefined) style.top = pos.top;
  if (pos.bottom !== undefined) style.bottom = pos.bottom;
  // The visible area, let through by the pointer: a press beside the panel
  // still reaches the page, and closes it as "outside".
  return createPortal(
    <div
      data-popover-area=""
      style={{ top: area.top, left: area.left, width: area.width, height: area.height }}
      className="pointer-events-none fixed z-[60]"
    >
      <NativeViewCover />
      <div
        ref={panel}
        id={id}
        role="dialog"
        aria-label={label}
        data-side={pos.side}
        style={style}
        className={cn(
          'pointer-events-auto absolute flex flex-col overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover text-popover-foreground shadow-elev-3 motion-safe:animate-in motion-safe:fade-in-0',
          pos.side === 'sheet' ? 'motion-safe:slide-in-from-bottom-4' : 'motion-safe:zoom-in-95',
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Touch-first screen. Read when placing, not from a hook settled one render late. */
export function coarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}
