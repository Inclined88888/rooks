import { BrowserWindow, shell } from 'electron';
import { themeFor, updateCopy, updatePage, type Progress, type UpdateOffer } from './data-update.js';

/** How often the approval screen counts the missions again while it waits for a choice. */
const MISSIONS_POLL_MS = 5_000;

/** No preload, Node access or remote document is needed before the daemon starts. */
export class UpdateWindow {
  readonly window: BrowserWindow;
  private approved = false;
  private finished = false;
  private choose: ((approve: boolean) => void) | undefined;
  readonly choice: Promise<boolean>;
  private poll: NodeJS.Timeout | undefined;
  /**
   * `countMissions`: the missions the service would stop if approved now (P3).
   * Counted while the screen waits; when some run, it says how many, "Quit"
   * becomes "Wait" (the service keeps running them on the installed
   * version) and "Update" becomes "Update anyway".
   */
  constructor(private offer: UpdateOffer, notesPath: string, private locale: string, scheme: 'light' | 'dark' = 'dark',
    private countMissions?: () => Promise<number>) {
    const page = updatePage(offer, notesPath, locale, scheme);
    this.window = new BrowserWindow({ width: 780, height: 720, minWidth: 480, minHeight: 480,
      title: 'Rooks', backgroundColor: themeFor(scheme).background, autoHideMenuBar: true,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    this.choice = new Promise(resolve => { this.choose = resolve; });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url === 'rooks-update:approve' && !this.approved) {
        this.approved = true;
        this.stopCounting();
        this.progress(updateCopy(locale).working);
        this.choose?.(true);
      } else if (url === 'rooks-update:quit' && !this.approved) {
        this.choose?.(false);
      } else if (page.links.includes(url)) void shell.openExternal(url);
    });
    this.window.on('closed', () => { this.stopCounting(); });
    if (countMissions) {
      this.window.webContents.on('did-finish-load', () => { void this.showMissions(); });
      this.poll = setInterval(() => { void this.showMissions(); }, MISSIONS_POLL_MS);
    }
    this.window.on('close', event => {
      // Once approved, closing a portable shell would interrupt its own migration.
      if (this.approved && !this.finished) event.preventDefault();
      else this.choose?.(false);
    });
    void this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page.html)}`);
  }
  private stopCounting(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }
  private async showMissions(): Promise<void> {
    if (!this.countMissions || this.approved) return;
    const count = await this.countMissions().catch(() => 0);
    if (this.approved || this.window.isDestroyed()) return;
    const copy = updateCopy(this.locale);
    const text = count > 0 ? copy.missions(count, this.offer.from) : '';
    void this.window.webContents.executeJavaScript(`
      { const m = document.getElementById('missions'); m.textContent = ${JSON.stringify(text)}; m.hidden = ${count > 0 ? 'false' : 'true'}; }
      document.getElementById('quit').textContent = ${JSON.stringify(count > 0 ? copy.wait : copy.quit)};
      document.getElementById('approve').textContent = ${JSON.stringify(count > 0 ? copy.approveAnyway : copy.approve)};
    `).catch(() => { /* A window being destroyed no longer needs the count. */ });
  }
  progress(message: string, progress?: Progress | null): void {
    if (this.window.isDestroyed()) return;
    const bytes = progress && progress.totalBytes > 0
      ? ` (${updateCopy(this.locale).bytes(Math.min(progress.copiedBytes, progress.totalBytes), progress.totalBytes)})` : '';
    void this.window.webContents.executeJavaScript(`
      document.getElementById('intro').hidden = true;
      document.getElementById('missions').hidden = true;
      document.getElementById('status').textContent = ${JSON.stringify(message + bytes)};
      for (const id of ['approve', 'quit']) { const b = document.getElementById(id); b.setAttribute('aria-disabled', 'true'); b.tabIndex = -1; }
      const p = document.getElementById('progress'); p.hidden = false;
      ${progress && progress.totalBytes > 0 ? `p.max = ${progress.totalBytes}; p.value = ${Math.min(progress.copiedBytes, progress.totalBytes)};` : "p.removeAttribute('value');"}
    `).catch(() => { /* A window being destroyed no longer needs progress. */ });
  }
  close(): void { this.finished = true; this.stopCounting(); this.window.destroy(); }
}
