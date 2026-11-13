/**
 * The windows of the shell (multi-window V3), and everything that belongs to
 * one of them: its origin, the machine on screen, the pages it keeps alive
 * (V4, `view-pool.ts`). Kept free of Electron so the bookkeeping is tested
 * without a display.
 *
 * The first window still open is the *primary* one: it parents the boxes that
 * belong to no window in particular. Browser panels belong to their own window.
 * When it closes, the next oldest takes the role.
 */
import type { PinnedWindow } from './window-machine.js';
import { ViewPool, type PooledView } from './view-pool.js';

export interface WindowRecord<W, P> {
  /** The webContents id of the window itself: what the registry files it under. Its pages have their own. */
  readonly id: number;
  readonly window: W;
  readonly origin: string;
  /** The machine on screen: what the layout remembers and the title names. */
  machineId: string | null;
  /** One page per machine visited, the most recent ones alive (V4). */
  readonly pages: ViewPool<P>;
  /** The window is closing its pages one by one before it goes. */
  closing: boolean;
  /**
   * The page on screen, as the layout reopens the window on it (TODO #760).
   * Kept on the window, not read from its page: the last window closes its
   * pages before the layout takes its picture.
   */
  route: string | null;
}

/** A page and the window it belongs to: what an IPC call or a request resolves to. */
export interface PageOf<W, P> {
  readonly record: WindowRecord<W, P>;
  readonly page: PooledView<P>;
}

export class WindowRegistry<W, P> {
  private readonly records = new Map<number, WindowRecord<W, P>>();

  add(record: WindowRecord<W, P>): WindowRecord<W, P> {
    this.records.set(record.id, record);
    return record;
  }

  remove(id: number): void { this.records.delete(id); }

  get(id: number): WindowRecord<W, P> | null { return this.records.get(id) ?? null; }

  /** The record of a window object, whichever id it was filed under. */
  find(window: W): WindowRecord<W, P> | null {
    for (const record of this.records.values()) if (record.window === window) return record;
    return null;
  }

  /** The page a webContents is, in whichever window, closing ones included. */
  pageOf(contentsId: number): PageOf<W, P> | null {
    for (const record of this.records.values()) {
      const page = record.pages.byContents(contentsId);
      if (page) return { record, page };
    }
    return null;
  }

  /** What the request hook needs of a webContents: its window's origin, and the machine of THAT page. */
  pinnedFor(contentsId: number): PinnedWindow | null {
    const found = this.pageOf(contentsId);
    return found ? { origin: found.record.origin, machineId: found.page.machineId } : null;
  }

  /** Oldest first: a Map iterates in insertion order. */
  list(): WindowRecord<W, P>[] { return [...this.records.values()]; }

  get size(): number { return this.records.size; }

  primary(): WindowRecord<W, P> | null {
    const first = this.records.values().next();
    return first.done ? null : first.value;
  }

  isPrimary(id: number): boolean { return this.primary()?.id === id; }

  /** True when `id` now shows another machine than before. */
  setMachine(id: number, machineId: string | null): boolean {
    const record = this.records.get(id);
    if (!record || record.machineId === machineId) return false;
    record.machineId = machineId;
    return true;
  }
}
