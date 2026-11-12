/**
 * Where an anchored popover goes, as a pure function of the anchor's box and
 * the viewport — so a test can pin it without a layout engine.
 *
 * The panel is never measured: its width is chosen (the preferred one, or the
 * viewport minus its margins on a phone) and its height is a CEILING handed to
 * the panel, which scrolls inside it. Measuring first would mean one frame
 * painted at the wrong place, and a second layout for every resize.
 */
export const POPOVER_EDGE = 8;
export const POPOVER_GAP = 6;

/** `below`: under the anchor (the top bar). `beside`: next to it, on the side
 *  that has room (a vertical rail) — below when neither side has. */
export type PopoverPlacement = 'below' | 'beside';

/** `below` only: which edges line up with the anchor's. `end` (right edges) is
 *  the top bar's menus; `start` (left edges) suits an anchor on the left, like
 *  the composer's model chip. */
export type PopoverAlign = 'start' | 'end';

export type AnchorBox = { top: number; left: number; right: number; bottom: number };
/**
 * The part of the page the user actually sees. `top` / `left` place it in the
 * anchor's frame (`getBoundingClientRect`, the layout viewport): on a phone
 * the soft keyboard only shrinks the VISUAL viewport, which the page may also
 * scroll under (`visualViewport.offsetTop`). 0 when the visible area is the
 * window. The position returned is relative to this area: the component pins
 * a box on it and lays the panel inside, so a CSS `bottom` is never measured
 * from a layout viewport that runs on behind the keyboard.
 */
export type Viewport = { width: number; height: number; top?: number; left?: number };

export type PopoverPosition = {
  /** `sheet`: across the foot of the visible area (`placeSheet`), wherever the anchor is. */
  side: 'below' | 'above' | 'right' | 'left' | 'sheet';
  left: number;
  /** One of `top` / `bottom` is set: the panel grows away from that edge. */
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
};

export function placePopover(
  layoutAnchor: AnchorBox,
  viewport: Viewport,
  { placement = 'below', align = 'end', width: preferred, maxHeight: cap = Infinity }: { placement?: PopoverPlacement; align?: PopoverAlign; width: number; maxHeight?: number },
): PopoverPosition {
  const anchor = inArea(layoutAnchor, viewport);
  const width = Math.max(0, Math.min(preferred, viewport.width - 2 * POPOVER_EDGE));
  const clampLeft = (x: number) => Math.max(POPOVER_EDGE, Math.min(x, viewport.width - width - POPOVER_EDGE));
  const ceiling = (room: number) => Math.max(0, Math.min(cap, room));

  if (placement === 'beside') {
    const roomRight = viewport.width - anchor.right - POPOVER_GAP - POPOVER_EDGE;
    const roomLeft = anchor.left - POPOVER_GAP - POPOVER_EDGE;
    const side = roomRight >= width ? 'right' : roomLeft >= width ? 'left' : null;
    if (side) {
      const left = side === 'right' ? anchor.right + POPOVER_GAP : anchor.left - POPOVER_GAP - width;
      // Level with the anchor, growing toward the larger half of the screen:
      // the bell at the foot of the nav rail opens upward, not into 80px.
      const roomDown = viewport.height - anchor.top - POPOVER_EDGE;
      const roomUp = anchor.bottom - POPOVER_EDGE;
      return fits(roomDown, roomUp, cap)
        ? { side, left, top: Math.max(POPOVER_EDGE, anchor.top), width, maxHeight: ceiling(roomDown) }
        : { side, left, bottom: Math.max(POPOVER_EDGE, viewport.height - anchor.bottom), width, maxHeight: ceiling(roomUp) };
    }
    // A phone: no side has the panel's width. Below, like the top bar.
  }

  const roomBelow = viewport.height - anchor.bottom - POPOVER_GAP - POPOVER_EDGE;
  const roomAbove = anchor.top - POPOVER_GAP - POPOVER_EDGE;
  // Right edges aligned by default, as a menu of the top bar's right side has
  // always been; the clamp brings it back on screen for an anchor on the left.
  const left = clampLeft(align === 'start' ? anchor.left : anchor.right - width);
  return fits(roomBelow, roomAbove, cap)
    ? { side: 'below', left, top: anchor.bottom + POPOVER_GAP, width, maxHeight: ceiling(roomBelow) }
    : { side: 'above', left, bottom: viewport.height - anchor.top + POPOVER_GAP, width, maxHeight: ceiling(roomAbove) };
}

/**
 * The preferred side is kept when the whole panel fits there, or when it still
 * has more room than the other one. A mere "useful" minimum is not enough: a
 * composer chip with 170px under it opened a 484px picker downward, squeezed
 * to a strip with no row to click, while the screen above stood empty.
 */
function fits(room: number, otherRoom: number, cap: number): boolean {
  return room >= cap || room >= otherRoom;
}

/** The anchor's box in the visible area's own coordinates. */
function inArea(anchor: AnchorBox, { top = 0, left = 0 }: Viewport): AnchorBox {
  return { top: anchor.top - top, left: anchor.left - left, right: anchor.right - left, bottom: anchor.bottom - top };
}

/** Under that visible width a screen is a phone's, whatever its pointer. */
export const PHONE_MAX_WIDTH = 640;
/** A sheet on a tablet stays a panel's width, centred, not a 1000px band. */
export const SHEET_MAX_WIDTH = 640;
/** Left free above a sheet: a soft keyboard has no Escape, so a tap outside
 *  must stay possible while it covers the rest of the screen. */
export const SHEET_TOP_RESERVE = 48;

/** A touch-first screen (`pointer: coarse`) or a phone-wide one gets the sheet. */
export function wantsSheet(viewport: Viewport, coarsePointer: boolean): boolean {
  return coarsePointer || viewport.width < PHONE_MAX_WIDTH;
}

/**
 * A sheet across the foot of the visible area: just above the soft keyboard
 * when it is open, above the screen's edge when not. It does not depend on
 * the anchor, so it never flips side while the keyboard slides in or out —
 * only its foot follows the keyboard, and its ceiling the room left.
 */
export function placeSheet(viewport: Viewport, { maxHeight: cap = Infinity }: { maxHeight?: number } = {}): PopoverPosition {
  const width = Math.max(0, Math.min(SHEET_MAX_WIDTH, viewport.width - 2 * POPOVER_EDGE));
  return {
    side: 'sheet',
    left: Math.round((viewport.width - width) / 2),
    bottom: POPOVER_EDGE,
    width,
    maxHeight: Math.max(0, Math.min(cap, viewport.height - POPOVER_EDGE - SHEET_TOP_RESERVE)),
  };
}
