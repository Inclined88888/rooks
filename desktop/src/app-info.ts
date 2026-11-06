/** Read-only facts about the desktop app, for the Settings window. */
export const APP_INFO_CHANNEL = 'timon:app-info';

/**
 * Same window, frame and origin checks as the uninstall pane, without its
 * `settings=system/desktop` tab: System › Installation opens on another tab
 * (or none), and a version number grants nothing.
 */
export function canReadAppInfo(sender: { isWindow: boolean; isMainFrame: boolean; url: string }, origin: string): boolean {
  try {
    return sender.isWindow && sender.isMainFrame && new URL(sender.url).origin === new URL(origin).origin;
  } catch { return false; }
}
