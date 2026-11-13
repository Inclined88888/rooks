/**
 * Defensive shutdown around the error boxes (TODO #478).
 *
 * The Linux AppImage 0.1.6-rc.5 crashed in GTK ("GLib-GObject … has no
 * handler with id", then a segfault) right after an error box, on a path
 * that destroyed the update window and quit while GTK was still tearing the
 * box down. Not reproduced here, so this only removes the overlaps we can
 * name: no window is destroyed and no quit runs while a box is open, and a
 * quit after a box is an explicit sequence — box closed, windows closed one by
 * one, then `app.quit()` — each step logged so a future crash can be placed.
 *
 * No Electron import: `main.ts` passes the windows and the quit in.
 */

export type ShutdownLog = (line: string) => void;

/** Counts the open error boxes; what must not happen meanwhile waits for the last one. */
export class ErrorBoxGate {
  private open = 0;
  private waiters: Array<() => void> = [];
  private quitDeferred = false;

  constructor(private readonly log: ShutdownLog, private readonly quit: () => void) {}

  get busy(): boolean { return this.open > 0; }

  /** Runs `show` as an open box until it settles, rejection included. */
  async hold<T>(show: () => Promise<T>): Promise<T> {
    this.open += 1;
    try {
      return await show();
    } finally {
      this.open -= 1;
      if (this.open === 0) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  /** Resolves at once when no box is open, else when the last one closes. */
  idle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }

  /**
   * Called from `before-quit`: true means "prevent this quit", which is
   * asked again once the boxes are closed. A tray Quit, a last window closed
   * or a crashed daemon cannot pull the app from under an open box.
   */
  deferQuit(): boolean {
    if (!this.busy) return false;
    if (!this.quitDeferred) {
      this.quitDeferred = true;
      this.log('[desktop] shutdown: quit requested while an error box is open, deferred until it closes');
      void this.idle().then(() => {
        this.quitDeferred = false;
        this.log('[desktop] shutdown: error box closed, resuming the deferred quit');
        this.quit();
      });
    }
    return true;
  }

  /** Destroys a window now, or once the open boxes are closed. */
  whenIdle(label: string, act: () => void): void {
    if (!this.busy) { act(); return; }
    this.log(`[desktop] shutdown: ${label} waits for the open error box`);
    void this.idle().then(() => {
      this.log(`[desktop] shutdown: ${label} now that the error box is closed`);
      act();
    });
  }
}

export type ShutdownWindow = {
  label: string;
  alive: () => boolean;
  /** Starts the close; `closed` resolves with the window's `closed` event. */
  close: () => void;
  closed: () => Promise<void>;
};

export type QuitAfterBoxDeps = {
  /** Shows the box; resolves when the user closed it. Clipboard writes happen inside. */
  box: () => Promise<void>;
  /** Read after the box: what is still open then is what gets closed. */
  windows: () => ShutdownWindow[];
  quit: () => void;
  log: ShutdownLog;
  /** A window that never reports `closed` (a page holding its unload) does not hold the quit forever. */
  closeTimeoutMs?: number;
};

/** Box, then each window, then quit — never two at once. */
export async function quitAfterBox(deps: QuitAfterBoxDeps): Promise<void> {
  deps.log('[desktop] shutdown: error box shown, nothing closes until it is dismissed');
  try {
    await deps.box();
    deps.log('[desktop] shutdown: error box closed');
  } catch (error) {
    deps.log(`[desktop] shutdown: error box failed (${(error as Error).message}), closing anyway`);
  }
  for (const window of deps.windows()) {
    if (!window.alive()) continue;
    deps.log(`[desktop] shutdown: closing the ${window.label}`);
    const closed = window.closed();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), deps.closeTimeoutMs ?? 3000);
    });
    try {
      window.close();
      const outcome = await Promise.race([closed.then(() => 'closed' as const), timeout]);
      deps.log(outcome === 'closed'
        ? `[desktop] shutdown: ${window.label} closed`
        : `[desktop] shutdown: ${window.label} did not close in time, quitting anyway`);
    } catch (error) {
      deps.log(`[desktop] shutdown: closing the ${window.label} failed (${(error as Error).message})`);
    } finally {
      clearTimeout(timer);
    }
  }
  deps.log('[desktop] shutdown: app.quit()');
  deps.quit();
}
