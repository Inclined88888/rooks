import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Rect { x: number; y: number; width: number; height: number }

export interface WindowState {
  /** Size and position of the window when it is neither maximized nor full screen. */
  bounds: Rect;
  maximized: boolean;
  fullScreen: boolean;
}

export interface WindowPlacement {
  width: number;
  height: number;
  /** Absent when the OS should place the window (first launch, unplugged display). */
  x?: number;
  y?: number;
  maximized: boolean;
  fullScreen: boolean;
}

export const DEFAULT_SIZE = { width: 1440, height: 900 } as const;
const MIN_SIZE = { width: 480, height: 320 } as const;
/** How much of the window must sit on a display for the user to be able to grab it. */
export const MIN_VISIBLE = 120;
const FILE = 'window-state.json';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function parseRect(raw: unknown): Rect | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height)) return null;
  if (r.width < MIN_SIZE.width || r.height < MIN_SIZE.height) return null;
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

/** The remembered window, or null when there is none or the file cannot be trusted. */
export function readWindowState(home: string): WindowState | null {
  try {
    const raw = JSON.parse(readFileSync(join(home, FILE), 'utf8')) as Record<string, unknown>;
    const bounds = parseRect(raw.bounds);
    if (!bounds) return null;
    return { bounds, maximized: raw.maximized === true, fullScreen: raw.fullScreen === true };
  } catch { return null; /* first launch, or an unreadable file: the defaults apply */ }
}

export function writeWindowState(home: string, state: WindowState): void {
  try {
    mkdirSync(home, { recursive: true });
    const file = join(home, FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, file);
  } catch { /* losing a window position must never take the app down */ }
}

export function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? Math.min(w, h) : 0;
}

/**
 * Where the window opens. The saved position is only reused when enough of it
 * lies on a connected display (a monitor unplugged since would otherwise leave
 * it off-screen); the size is kept either way, capped to the largest display.
 */
export function placementFor(state: WindowState | null, displays: readonly Rect[]): WindowPlacement {
  if (!state) return { ...DEFAULT_SIZE, maximized: false, fullScreen: false };
  const { bounds } = state;
  const maxW = Math.max(0, ...displays.map((d) => d.width));
  const maxH = Math.max(0, ...displays.map((d) => d.height));
  const width = maxW > 0 ? Math.min(bounds.width, maxW) : bounds.width;
  const height = maxH > 0 ? Math.min(bounds.height, maxH) : bounds.height;
  const reachable = displays.some((d) => overlap(bounds, d) >= MIN_VISIBLE);
  const base = { width, height, maximized: state.maximized, fullScreen: state.fullScreen };
  return reachable && width === bounds.width && height === bounds.height
    ? { ...base, x: bounds.x, y: bounds.y }
    : base;
}

/** The slice of BrowserWindow the tracker needs, so it can be driven without Electron. */
export interface TrackedWindow {
  getNormalBounds(): Rect;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  isDestroyed(): boolean;
  on(event: 'resize' | 'move' | 'close', listener: () => void): unknown;
}

/**
 * Persists the window's size and position when it moves or closes. Resizes and
 * moves are debounced (a drag fires dozens of events); `close` flushes at once.
 * `getNormalBounds()` keeps the restored size while the window is maximized or
 * full screen, so leaving those modes later returns to the user's own size.
 */
export function trackWindowState(
  w: TrackedWindow, home: string,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as NodeJS.Timeout),
  },
  delayMs = 500,
): void {
  let pending: unknown = null;
  const save = (): void => {
    if (pending !== null) { timers.clear(pending); pending = null; }
    if (w.isDestroyed()) return;
    writeWindowState(home, { bounds: w.getNormalBounds(), maximized: w.isMaximized(), fullScreen: w.isFullScreen() });
  };
  const schedule = (): void => {
    if (pending !== null) timers.clear(pending);
    pending = timers.set(save, delayMs);
  };
  w.on('resize', schedule);
  w.on('move', schedule);
  w.on('close', save);
}
