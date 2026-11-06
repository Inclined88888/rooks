/**
 * Reload keys for the app window. The window hides its menu bar, so nothing
 * guarantees the browser's usual reload keys: a tester who just updated the
 * interface had no way to reload it. Handled on `before-input-event`, they work
 * the same on the three OSes.
 */

/** The fields of Electron's `Input` this reads. */
export type ReloadKeyInput = {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
};

/**
 * `reload` for Ctrl+R (Cmd+R on macOS) and F5, `force` (cache bypassed) with
 * Shift or for Ctrl+F5, `null` for any other key.
 */
export function reloadShortcut(input: ReloadKeyInput, platform: NodeJS.Platform): 'reload' | 'force' | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  const command = platform === 'darwin' ? input.meta : input.control;
  if (input.key === 'F5') return input.shift || command ? 'force' : 'reload';
  if (command && input.key.toLowerCase() === 'r') return input.shift ? 'force' : 'reload';
  return null;
}
