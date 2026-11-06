import { isAbsolute } from 'node:path';
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron';

export const SELECT_DIRECTORY_CHANNEL = 'timon:select-directory';

export async function selectDirectory(
  sender: { isWindow: boolean; isMainFrame: boolean; url: string },
  uiOrigin: string,
  defaultPath: unknown,
  open: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
): Promise<string | null> {
  let trusted = false;
  try {
    trusted = sender.isWindow && sender.isMainFrame
      && new URL(sender.url).origin === new URL(uiOrigin).origin;
  } catch { /* Reject malformed or missing frame URLs. */ }
  if (!trusted) throw new Error('Directory selection is only available from Timon.');
  const result = await open({
    properties: ['openDirectory', 'createDirectory'],
    ...(typeof defaultPath === 'string' && isAbsolute(defaultPath)
      ? { defaultPath } : {}),
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
}

export const SELECT_PLUGIN_SOURCE_CHANNEL = 'timon:select-plugin-source';

/**
 * "Install a plugin" in the gallery (TODO #332): a plugin folder, or its
 * `.tgz` or `.zip` (TODO #345). Two calls rather than one dialog, because
 * Windows and Linux cannot show a picker that accepts both files and folders. Same sender check as
 * `selectDirectory`: only Timon's own window may open it. The path goes back
 * to the page, which hands it to the daemon — the daemon validates it again.
 */
export async function selectPluginSource(
  sender: { isWindow: boolean; isMainFrame: boolean; url: string },
  uiOrigin: string,
  kind: unknown,
  open: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
): Promise<string | null> {
  let trusted = false;
  try {
    trusted = sender.isWindow && sender.isMainFrame
      && new URL(sender.url).origin === new URL(uiOrigin).origin;
  } catch { /* Reject malformed or missing frame URLs. */ }
  if (!trusted) throw new Error('Plugin selection is only available from Timon.');
  if (kind !== 'folder' && kind !== 'archive') throw new Error('Unknown plugin source kind.');
  const result = await open(kind === 'folder'
    ? { properties: ['openDirectory'] }
    // `tar.gz` cannot be a filter (one extension per entry): `gz` covers it, the daemon checks the name.
    : { properties: ['openFile'], filters: [{ name: 'Timon plugin (.tgz, .zip)', extensions: ['tgz', 'gz', 'zip'] }] });
  const path = result.canceled ? null : result.filePaths[0] ?? null;
  return path && isAbsolute(path) ? path : null;
}

export const SELECT_EXECUTABLE_CHANNEL = 'timon:select-executable';

/**
 * "Browse…" beside a backend CLI path in Settings › AI models (TODO #413).
 * Same sender check as `selectDirectory`. Hidden files are shown: the CLIs
 * live in `~/.local/bin`, `~/.npm-global/bin`, `~/.volta/bin`. On macOS an
 * `.app` opens as a folder, so the binary inside it can be picked. The page
 * hands the path to the daemon, which checks it is an executable file.
 */
export async function selectExecutable(
  sender: { isWindow: boolean; isMainFrame: boolean; url: string },
  uiOrigin: string,
  defaultPath: unknown,
  open: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  let trusted = false;
  try {
    trusted = sender.isWindow && sender.isMainFrame
      && new URL(sender.url).origin === new URL(uiOrigin).origin;
  } catch { /* Reject malformed or missing frame URLs. */ }
  if (!trusted) throw new Error('Binary selection is only available from Timon.');
  const result = await open({
    properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'],
    ...(platform === 'win32'
      ? { filters: [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat'] }, { name: 'All files', extensions: ['*'] }] }
      : {}),
    ...(typeof defaultPath === 'string' && isAbsolute(defaultPath) ? { defaultPath } : {}),
  });
  const path = result.canceled ? null : result.filePaths[0] ?? null;
  return path && isAbsolute(path) ? path : null;
}
