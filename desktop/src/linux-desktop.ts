/**
 * How a Linux dock ties Timon's windows to its launcher (01/11/2026).
 *
 * GNOME and KDE attach a window to the `.desktop` entry whose
 * `StartupWMClass` is the window's class (X11 `WM_CLASS`, Wayland `app_id`),
 * and read "New Window" from that entry's actions. Electron names the class
 * after the app's package.json: `timon-desktop` in a package (its `name`; the
 * packaged file has no productName), the `StartupWMClass` of the packaged
 * entry; but `Electron` when run from the sources, which no entry claims (and
 * every other Electron app run that way shares). From the sources the shell
 * therefore renames itself `timon-dev`, the entry
 * `scripts/install-dev-desktop-entry.mjs` writes: its windows land on that
 * icon, never on an installed Timon's.
 */

/** Class and desktop id of a shell run from the sources; the dev-entry script holds a copy. */
export const DEV_DESKTOP_ID = 'timon-dev';

/** The flag the launcher's "New Window" action passes; a running shell opens one more window. */
export const NEW_WINDOW_FLAG = '--new-window';

/**
 * The name a shell run from the sources takes on Linux, or `null` to keep
 * Electron's: a package already carries `timon-desktop`, and the other OS
 * have no class to match.
 */
export function devShellName(platform: NodeJS.Platform, packaged: boolean): string | null {
  return platform === 'linux' && !packaged ? DEV_DESKTOP_ID : null;
}
