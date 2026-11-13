import { BrowserWindow, shell } from 'electron';
import { themeFor } from './data-update.js';
import { ABOUT_CLOSE_URL, aboutCopy, aboutPage } from './about.js';

/** One window at a time: asking again brings the open one forward. No preload, no Node, no remote document. */
let current: BrowserWindow | null = null;

export function showAboutWindow(input: {
  version: string;
  daemonVersion?: string | null;
  electron: string;
  notices: string | null;
  locale: string;
  scheme: 'light' | 'dark';
  icon?: string;
}): void {
  if (current && !current.isDestroyed()) {
    if (current.isMinimized()) current.restore();
    current.show();
    current.focus();
    return;
  }
  const page = aboutPage(input);
  const window = new BrowserWindow({ width: 680, height: 640, minWidth: 420, minHeight: 360,
    title: aboutCopy(input.locale).title, backgroundColor: themeFor(input.scheme).background, autoHideMenuBar: true,
    ...(input.icon ? { icon: input.icon } : {}),
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  current = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url === ABOUT_CLOSE_URL) window.close();
    else if (page.links.includes(url)) void shell.openExternal(url);
  });
  window.on('closed', () => { if (current === window) current = null; });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page.html)}`);
}
