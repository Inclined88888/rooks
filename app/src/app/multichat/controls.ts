/**
 * Shared look of the side bar controls, so the templates menu, the grid
 * picker and the collapse button read as one row, and the folded rail's
 * icons as one column.
 */

export const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** A labelled control of the open side bar's top row. */
export const RAIL_CONTROL =
  'flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2 text-[10.5px] text-foreground transition-colors hover:border-border hover:bg-muted/50 data-[state=open]:border-primary/50 data-[state=open]:bg-muted/50 ' +
  FOCUS_RING;

/** An icon-only control: the collapse button, and every control of the folded rail. */
export const RAIL_ICON_BUTTON =
  'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground ' +
  FOCUS_RING;

export type ControlVariant = 'full' | 'icon';
