/**
 * The arrangement of the shell's windows (multi-window V3): which windows were
 * open, on which display, at which size, on which machine — written as they
 * move and when Rooks quits, put back at the next launch.
 *
 * A display unplugged since (a laptop leaving its dock, a third screen turned
 * off) must not leave a window out of reach: such a window comes back on the
 * display it was on if that one is still there with other coordinates, else on
 * the primary display, fully inside its work area.
 *
 * Each window also reopens on the page it showed (TODO #760): a window
 * detached on `/kanban` comes back on `/kanban`, not on the home page.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMachineId } from './window-machine.js';
import {
  DEFAULT_SIZE, MIN_VISIBLE, overlap, parseRect, readWindowState, type Rect, type WindowPlacement,
} from './window-state.js';

export interface SavedWindow {
  /** Size and position when neither maximized nor full screen (`getNormalBounds`). */
  bounds: Rect;
  maximized: boolean;
  fullScreen: boolean;
  /** The display it was on, as `screen.getDisplayMatching` named it; null when unknown. */
  displayId: number | null;
  /** The machine it drove; null = the `nova_machine` cookie. */
  machineId: string | null;
  /** The page it showed (`layoutRoute`); null = the home page. */
  route: string | null;
}

export interface WindowLayout {
  windows: SavedWindow[];
  /** The machine chosen last in any window: where a new window opens. */
  lastMachine: string | null;
}

export interface DisplayArea {
  id: number;
  bounds: Rect;
  /** The bounds minus the task bar, the dock, the menu bar. */
  workArea: Rect;
}

export interface WindowOpening {
  placement: WindowPlacement;
  machineId: string | null;
}

/** A remembered window put back: where, on which machine, on which page. */
export interface RestoredWindow extends WindowOpening {
  route: string | null;
}

const FILE = 'window-layout.json';
/** Far more than three screens need; a corrupt file must not open a hundred windows. */
export const MAX_WINDOWS = 12;
/** How far a new or displaced window shifts from the previous one, so none hides another. */
export const CASCADE = 32;

const EMPTY: WindowLayout = { windows: [], lastMachine: null };

const ROUTE_MAX = 2048;
/** The base a route is parsed against: only an origin the route cannot change. */
const PARSE_BASE = 'http://rooks.invalid';
/** Copy of `NOT_A_PLACE` (`app/src/lib/machines/last-route.ts`); `window-layout.test.ts` compares both. */
export const NOT_A_PLACE = ['/api', '/_next', '/login', '/setup', '/invite', '/confirm-email'];
/** Copy of `OVERLAY_PARAMS` (same file); `window-layout.test.ts` compares both. */
export const OVERLAY_PARAMS = ['settings'];

const underPrefix = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`); // portability: a URL pathname, not a file path

/**
 * `raw` as a page to reopen a window on — `pathname + search`, overlay
 * parameters and fragment dropped — or `null`. The same rule as `safeRoute`
 * on the app side, checked again here: the file is anyone's to edit, and the
 * route ends up in the address the window loads. Only a relative path with ONE
 * leading `/` passes; sign-in, setup, invitations and the API are not a place
 * to come back to.
 */
export function layoutRoute(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > ROUTE_MAX) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PARSE_BASE);
  } catch {
    return null;
  }
  if (url.origin !== PARSE_BASE) return null;
  if (NOT_A_PLACE.some((prefix) => underPrefix(url.pathname, prefix))) return null;
  for (const name of OVERLAY_PARAMS) url.searchParams.delete(name);
  return `${url.pathname}${url.search}`;
}

/**
 * The page a window's address names, when it is a page of `origin` worth
 * reopening (`layoutRoute`); `null` for the waiting page, another origin, or
 * an address that does not parse.
 */
export function routeOfUrl(address: string, origin: string): string | null {
  try {
    const url = new URL(address);
    if (url.origin !== new URL(origin).origin) return null;
    return layoutRoute(`${url.pathname}${url.search}`);
  } catch {
    return null;
  }
}

function parseWindow(raw: unknown): SavedWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const w = raw as Record<string, unknown>;
  const bounds = parseRect(w.bounds);
  if (!bounds) return null;
  return {
    bounds,
    maximized: w.maximized === true,
    fullScreen: w.fullScreen === true,
    displayId: typeof w.displayId === 'number' && Number.isFinite(w.displayId) ? w.displayId : null,
    machineId: isMachineId(w.machineId) ? w.machineId : null,
    // Absent from a layout written before TODO #760, or refused: the home page, the window is kept.
    route: layoutRoute(w.route),
  };
}

/**
 * The remembered arrangement. Before windows had their own machine, the shell
 * kept one window in `window-state.json`: read as a one-window layout on the
 * cookie's machine, so the first launch of this version opens where the last
 * one closed.
 */
export function readWindowLayout(home: string): WindowLayout {
  try {
    const raw = JSON.parse(readFileSync(join(home, FILE), 'utf8')) as Record<string, unknown>;
    const windows = Array.isArray(raw.windows)
      ? raw.windows.map(parseWindow).filter((w): w is SavedWindow => w !== null).slice(0, MAX_WINDOWS)
      : [];
    return { windows, lastMachine: isMachineId(raw.lastMachine) ? raw.lastMachine : null };
  } catch { /* no layout yet, or unreadable: the single-window state, if any */ }
  const legacy = readWindowState(home);
  return legacy ? { windows: [{ ...legacy, displayId: null, machineId: null, route: null }], lastMachine: null } : { ...EMPTY };
}

export function writeWindowLayout(home: string, layout: WindowLayout): void {
  try {
    mkdirSync(home, { recursive: true });
    const file = join(home, FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ windows: layout.windows.slice(0, MAX_WINDOWS), lastMachine: layout.lastMachine }));
    renameSync(temporary, file);
  } catch { /* losing a window position must never take the app down */ }
}

const contains = (outer: Rect, inner: Rect): boolean => inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** `rect` moved (not resized) so it lies inside `area`, as far as its size allows. */
function clampInto(rect: Rect, area: Rect): Rect {
  const x = Math.min(Math.max(rect.x, area.x), area.x + Math.max(0, area.width - rect.width));
  const y = Math.min(Math.max(rect.y, area.y), area.y + Math.max(0, area.height - rect.height));
  return { ...rect, x, y };
}

/** The display a window sits on most, if it is reachable on any. */
function bestDisplay(bounds: Rect, displays: readonly DisplayArea[]): DisplayArea | null {
  let best: DisplayArea | null = null;
  let bestOverlap = 0;
  for (const display of displays) {
    const o = overlap(bounds, display.bounds);
    if (o > bestOverlap) { best = display; bestOverlap = o; }
  }
  return bestOverlap >= MIN_VISIBLE ? best : null;
}

/**
 * Where each remembered window reopens. `displays` lists the primary display
 * first. A window still reachable keeps its exact place when it fits its
 * display; otherwise it lands on the display it was on (same id, new
 * coordinates) or on the primary one, centred in the work area, each displaced
 * window shifted by `CASCADE` from the previous so none hides another.
 * Without any display (it does happen while a session locks), the OS decides.
 */
export function placeSavedWindows(saved: readonly SavedWindow[], displays: readonly DisplayArea[]): RestoredWindow[] {
  const displaced = new Map<number, number>();
  return saved.slice(0, MAX_WINDOWS).map((w): RestoredWindow => {
    const modes = { maximized: w.maximized, fullScreen: w.fullScreen };
    const { machineId, route } = w;
    if (displays.length === 0) return { machineId, route, placement: { width: w.bounds.width, height: w.bounds.height, ...modes } };
    const reachable = bestDisplay(w.bounds, displays);
    if (reachable && w.bounds.width <= reachable.workArea.width && w.bounds.height <= reachable.workArea.height) {
      return { machineId, route, placement: { ...w.bounds, ...modes } };
    }
    const target = reachable ?? displays.find((d) => d.id === w.displayId) ?? displays[0]!;
    const area = target.workArea;
    const width = Math.min(w.bounds.width, area.width);
    const height = Math.min(w.bounds.height, area.height);
    const step = displaced.get(target.id) ?? 0;
    displaced.set(target.id, step + 1);
    const centred = {
      x: Math.round(area.x + (area.width - width) / 2) + step * CASCADE,
      y: Math.round(area.y + (area.height - height) / 2) + step * CASCADE,
      width, height,
    };
    return { machineId, route, placement: { ...clampInto(centred, area), ...modes } };
  });
}

/**
 * Where a window opened by hand ("New window", a second launch) goes: just
 * below and to the right of `from` (the window in front), kept inside the work
 * area of the display `from` is on — back to its top-left corner when the
 * shift would leave it. Without a window to start from, the default size,
 * placed by the OS.
 */
export function cascadeFrom(from: Rect | null, displays: readonly DisplayArea[]): WindowPlacement {
  if (!from) return { ...DEFAULT_SIZE, maximized: false, fullScreen: false };
  const display = bestDisplay(from, displays) ?? displays[0];
  if (!display) return { width: from.width, height: from.height, maximized: false, fullScreen: false };
  const area = display.workArea;
  const width = Math.min(from.width, area.width);
  const height = Math.min(from.height, area.height);
  let next: Rect = { x: from.x + CASCADE, y: from.y + CASCADE, width, height };
  if (!contains(area, next)) next = { x: area.x, y: area.y, width, height };
  return { ...next, maximized: false, fullScreen: false };
}

/** The timer slice the keeper needs, so it runs without real time in tests. */
export interface LayoutTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (t: unknown) => void;
}

/**
 * Keeps `window-layout.json` in step with the open windows. Moves and resizes
 * are debounced (a drag fires dozens of events). The last window to close is
 * kept, so reopening Rooks from the tray or the dock brings it back where it
 * was; the others are forgotten when the user closes them one by one. Quitting
 * freezes the file first: the windows Electron closes on the way out are part
 * of the arrangement to restore, not windows the user dismissed.
 */
export class WindowLayoutKeeper {
  private layout: WindowLayout;
  private pending: unknown = null;
  private lastClosed: SavedWindow | null = null;
  private frozen = false;

  constructor(
    initial: WindowLayout,
    private readonly deps: {
      /** The windows open right now, oldest first. */
      snapshot: () => SavedWindow[];
      write: (layout: WindowLayout) => void;
      timers?: LayoutTimers;
      delayMs?: number;
    },
  ) {
    this.layout = { windows: [...initial.windows], lastMachine: initial.lastMachine };
  }

  get current(): WindowLayout { return { windows: [...this.layout.windows], lastMachine: this.layout.lastMachine }; }

  private get timers(): LayoutTimers {
    return this.deps.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as NodeJS.Timeout) };
  }

  /** A window moved, resized, opened or changed machine. */
  changed(): void {
    if (this.frozen) return;
    if (this.pending !== null) this.timers.clear(this.pending);
    this.pending = this.timers.set(() => this.save(), this.deps.delayMs ?? 500);
  }

  /** A window is about to close: what it looked like, in case it is the last. */
  closing(window: SavedWindow): void {
    if (!this.frozen) this.lastClosed = window;
  }

  /** A machine was chosen in a window: new windows open there. */
  machineChosen(machineId: string | null): void {
    this.layout.lastMachine = isMachineId(machineId) ? machineId : null;
    this.changed();
  }

  save(): void {
    if (this.pending !== null) { this.timers.clear(this.pending); this.pending = null; }
    if (this.frozen) return;
    const open = this.deps.snapshot();
    if (open.length > 0) this.layout.windows = open;
    else if (this.lastClosed) this.layout.windows = [this.lastClosed];
    // Neither open nor closed windows yet: what was read at launch stays.
    this.deps.write(this.current);
  }

  /** Rooks is quitting: save the windows as they are, then ignore their closing. */
  freeze(): void {
    this.save();
    this.frozen = true;
  }

  /**
   * The quit was called off ("Stay" on unsaved changes, TODO #758): the
   * windows are followed again, and the file says which ones are still open.
   */
  thaw(): void {
    if (!this.frozen) return;
    this.frozen = false;
    this.save();
  }
}
