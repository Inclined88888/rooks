import { startupText } from './startup-text.js';

/** When the user should try again; none: right away. */
export type ReopenWhen = 'moment' | 'minute';

/**
 * How the user gets the window back after a failed start. "From the tray" is
 * only true when the tray exists: its icon may fail to load, and it is not
 * built while an update is pending — without it, closing the window quits the
 * app, so the only way back is to launch it again.
 */
export function reopenHint(locale: string, hasTray: boolean, appName: string, when?: ReopenWhen): string {
  const t = startupText(locale);
  const vars = { app: appName, when: when ?? 'now' };
  return hasTray ? t('startup.reopenTray', vars) : t('startup.reopenRelaunch', vars);
}
