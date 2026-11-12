/**
 * The machines a desktop window keeps alive (multi-window V4).
 *
 * A window hosts one page per machine it visited: switching hides the page on
 * screen and shows the other one, with its scroll, drafts and panels exactly
 * as they were, instead of loading the interface again. A page costs a
 * renderer (~200-300 MB), so a window keeps the {@link LIVE_VIEWS_PER_WINDOW}
 * it showed last; the least recently shown is closed when one more comes in,
 * and coming back to it opens the machine's last page again (`lastRouteFor`,
 * app side).
 *
 * A closed page is not gone at once: it may still send a request or two while
 * it unloads (each must still name its machine), and a page with unsaved
 * changes can refuse to go (`beforeunload`, TIM-0128). It is *closing* until
 * its webContents is destroyed (`forget`) or the user keeps it (`keep`).
 *
 * Kept free of Electron so eviction and bookkeeping are tested without a
 * display: `V` is whatever the shell attaches to a page.
 */

/** At most this many machines stay alive in one window. A constant until someone needs a setting. */
export const LIVE_VIEWS_PER_WINDOW = 3;

export interface PooledView<V> {
  /** The id of the page's webContents: the key every request and IPC call carries. */
  readonly contentsId: number;
  /** The machine the page drives; `null` leaves the `nova_machine` cookie in charge. */
  readonly machineId: string | null;
  readonly view: V;
}

/** What `enter` changed: the page to show, the one to hide, the ones to close. */
export interface PoolStep<V> {
  readonly entering: PooledView<V>;
  /** The page that was on screen, when it is another one. */
  readonly leaving: PooledView<V> | null;
  readonly created: boolean;
  /** Pushed out by the limit, now closing: the caller closes their webContents. */
  readonly evicted: readonly PooledView<V>[];
}

export class ViewPool<V> {
  /** Least recently shown first: the last one is on screen. */
  private live: PooledView<V>[] = [];
  private readonly closing = new Map<number, PooledView<V>>();

  constructor(readonly limit: number = LIVE_VIEWS_PER_WINDOW) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('A window keeps at least one page.');
  }

  /** The page on screen, if any. */
  get active(): PooledView<V> | null { return this.live.at(-1) ?? null; }

  /** Pages alive and not closing, least recently shown first. */
  list(): PooledView<V>[] { return [...this.live]; }

  get size(): number { return this.live.length; }

  /** Pages asked to close that still exist. */
  get closingCount(): number { return this.closing.size; }

  /** Pages asked to close that still exist, in the order they were asked. */
  closingPages(): PooledView<V>[] { return [...this.closing.values()]; }

  /** Every page that still exists, live or closing: what a window destroyed outright must close. */
  everyPage(): PooledView<V>[] { return [...this.live, ...this.closing.values()]; }

  /** The live page of a machine. */
  find(machineId: string | null): PooledView<V> | null {
    return this.live.find((page) => page.machineId === machineId) ?? null;
  }

  /** Any page a request or an IPC call may come from, closing ones included. */
  byContents(contentsId: number): PooledView<V> | null {
    return this.live.find((page) => page.contentsId === contentsId) ?? this.closing.get(contentsId) ?? null;
  }

  isClosing(contentsId: number): boolean { return this.closing.has(contentsId); }

  isActive(contentsId: number): boolean { return this.active?.contentsId === contentsId; }

  /**
   * Puts `machineId` on screen: its live page when there is one, else the page
   * `create` builds. The least recently shown pages beyond the limit move to
   * closing; the one entered never does.
   */
  enter(machineId: string | null, create: () => PooledView<V>): PoolStep<V> {
    const before = this.active;
    let entering = this.find(machineId);
    const created = entering === null;
    if (entering) this.live = this.live.filter((page) => page !== entering);
    else {
      entering = create();
      if (entering.machineId !== machineId) throw new Error('The page created drives another machine.');
      if (this.byContents(entering.contentsId)) throw new Error('This page is already in the window.');
    }
    this.live.push(entering);
    const evicted: PooledView<V>[] = [];
    while (this.live.length > this.limit) {
      const oldest = this.live.shift()!;
      this.closing.set(oldest.contentsId, oldest);
      evicted.push(oldest);
    }
    return { entering, leaving: before && before !== entering ? before : null, created, evicted };
  }

  /** Moves a live page to closing (the window is closing). False when it is not live. */
  close(contentsId: number): boolean {
    const page = this.live.find((candidate) => candidate.contentsId === contentsId);
    if (!page) return false;
    this.live = this.live.filter((candidate) => candidate !== page);
    this.closing.set(contentsId, page);
    return true;
  }

  /**
   * A closing page stays after all (the user kept its unsaved changes): live
   * again, as the least recently shown, so the caller can bring it in front.
   */
  keep(contentsId: number): boolean {
    const page = this.closing.get(contentsId);
    if (!page) return false;
    this.closing.delete(contentsId);
    this.live.unshift(page);
    return true;
  }

  /** The page's webContents is destroyed: nothing of it is kept. */
  forget(contentsId: number): PooledView<V> | null {
    const closing = this.closing.get(contentsId);
    if (closing) { this.closing.delete(contentsId); return closing; }
    const page = this.live.find((candidate) => candidate.contentsId === contentsId) ?? null;
    if (page) this.live = this.live.filter((candidate) => candidate !== page);
    return page;
  }
}
