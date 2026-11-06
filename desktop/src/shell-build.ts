/**
 * Which build of the shell is running (multi-window, 01/11/2026).
 *
 * A second launch never starts a second shell: it hands over to the one
 * already running (`second-instance`), which opens the window. The pages of
 * that window read `preload.cjs` from disk when they are created, the main
 * process does not reload `main.js`: after a rebuild or an update installed
 * while Timon runs, a new page offers bridges the old main process does not
 * serve. That is how "Open in a new window" answered "No handler
 * registered for 'timon:open-window'" on a shell started four days before
 * its rebuild. The second launch says which build it is; the running shell
 * compares, and asks to be restarted instead of opening a window it cannot
 * serve.
 */
import { shellText } from './shell-i18n.js';

/** What a second launch sends to the running shell (`requestSingleInstanceLock`). */
export interface LaunchData {
  readonly build: string;
}

/**
 * The build of this shell.
 *
 * From the sources, a rebuild changes `dist/main.js`, not the version: its
 * mtime tells two builds apart. In a package, `main.js` lives in `app.asar`,
 * and Electron's asar wrapper answers `stat` with the time the process loaded
 * the archive: two launches of the same package would always differ, and every
 * second launch would ask for a restart instead of opening a window. The
 * version alone names a package: every published build carries its own,
 * release candidates included (`x.y.z-rc.N`). The real mtime of `app.asar`
 * (`original-fs`) was the other candidate; it depends on what each installer
 * (NSIS, dpkg, AppImage, a copy into /Applications) keeps of the file's time,
 * which cannot be checked here, and a false difference blocks every new window.
 */
export function shellBuild(input: { packaged: boolean; version: string; mainModifiedMs: number | null }): string {
  if (input.packaged || input.mainModifiedMs === null) return input.version;
  return `${input.version}+${Math.trunc(input.mainModifiedMs)}`;
}

/**
 * True when the second launch carries a build, and it is not ours, newer or
 * older. A launch that says nothing (an older shell) is taken as ours: there
 * is nothing to compare, and refusing it would refuse every older build.
 */
export function launchedOtherBuild(own: string, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const build = (data as { build?: unknown }).build;
  return typeof build === 'string' && build.length > 0 && build !== own;
}

export function staleShellCopy(locale: string, appName: string): { message: string; detail: string } {
  const t = shellText(locale);
  return { message: t('staleShell.message', { appName }), detail: t('staleShell.detail', { appName }) };
}
