import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { DesktopSession } from './desktop-session.js';
import type { RevealVia } from './types.js';

/** How the file manager is launched: the command line, never a shell string. */
export type RevealCommand = {
  file: string;
  args: string[];
  /** Windows only: the argument is already a finished command-line fragment. */
  windowsVerbatimArguments: boolean;
  via: RevealVia;
};

export type RevealRun = (
  command: RevealCommand,
) => Promise<{ code: number; stderr: string }>;

const REVEAL_TIMEOUT_MS = 10_000;

/** What the "open this folder" decision reads from the disk. */
export type RevealFs = {
  isDirectory(path: string): boolean;
  realpath(path: string): string;
  exists(path: string): boolean;
};

const nodeFs: RevealFs = {
  isDirectory: (path) => statSync(path).isDirectory(),
  realpath: (path) => realpathSync(path),
  exists: (path) => existsSync(path),
};

/**
 * Whether `target` may be handed to the file manager as "open this folder"
 * (as opposed to "select it in its parent").
 *
 * On macOS a bundle (`Calculator.app`, a framework, a plug-in…) is a
 * directory, and `open <dir>` / `NSWorkspace.openURL` runs it with its default
 * handler instead of showing it. Package-ness is decided by Launch Services
 * from the extension, so the rule fails closed: a directory is opened only
 * when neither its own name nor the name it resolves to carries an extension
 * (a symlink to `X.app` is the same bundle) and it has no `Contents/Info.plist`.
 * Everything else is revealed with `open -R`, which selects without launching.
 * Windows and Linux open any directory: a folder is never executed there.
 */
export function opensAsFolder(
  platform: 'win32' | 'darwin',
  target: string,
  fs: RevealFs = nodeFs,
): boolean {
  if (!fs.isDirectory(target)) return false;
  if (platform !== 'darwin') return true;
  let resolved: string;
  try { resolved = fs.realpath(target); } catch { return false; }
  return [target, resolved].every((path) => (
    posix.extname(posix.basename(path)) === ''
    && !fs.exists(posix.join(path, 'Contents', 'Info.plist'))
  ));
}

/**
 * The command that shows `target` in the OS file manager, selecting it unless
 * `openFolder` (see `opensAsFolder`). Pure: the folder decision is a parameter
 * because `statSync` of a Windows path is not possible from the platform the
 * tests run on.
 *
 * Windows: Explorer parses its own command line, and re-quoting by Node
 * (`"/select,C:\a b\x.txt"`) makes it open Documents instead. The argument is
 * therefore built by hand and passed verbatim; `"` cannot appear in a Windows
 * file name, so the quoting cannot be escaped from.
 */
export function revealCommand(
  platform: 'win32' | 'darwin',
  target: string,
  openFolder: boolean,
  env: NodeJS.ProcessEnv = process.env,
): RevealCommand {
  if (target.includes('\0')) throw new Error('invalid path');
  if (platform === 'darwin') {
    return {
      file: '/usr/bin/open', // portability: macOS-only branch, absolute path on purpose
      args: openFolder ? [target] : ['-R', target],
      windowsVerbatimArguments: false,
      via: 'finder',
    };
  }
  const native = win32.normalize(target);
  if (native.includes('"')) throw new Error('invalid path');
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return {
    file: win32.join(root, 'explorer.exe'),
    args: [openFolder ? `"${native}"` : `/select,"${native}"`],
    windowsVerbatimArguments: true,
    via: 'explorer',
  };
}

/** Real launcher: resolves with the exit code, rejects only when the process
 *  could not be started (ENOENT) or was killed by the timeout. */
export const runReveal: RevealRun = (command) => new Promise((resolve, reject) => {
  execFile(command.file, command.args, {
    timeout: REVEAL_TIMEOUT_MS,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  }, (error, _stdout, stderr) => {
    if (!error) return resolve({ code: 0, stderr: String(stderr) });
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'number') return resolve({ code, stderr: String(stderr) });
    reject(error);
  });
});

/**
 * Shows `target` in Explorer (Windows) or Finder (macOS) and returns the lane
 * taken. `explorer.exe` exits 1 even when the window opened, so on Windows only
 * a launch failure is an error; `open` has a reliable exit code.
 */
export async function revealInFileManager(
  platform: 'win32' | 'darwin',
  target: string,
  openFolder: boolean,
  run: RevealRun = runReveal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RevealVia> {
  const command = revealCommand(platform, target, openFolder, env);
  let result: { code: number; stderr: string };
  try {
    result = await run(command);
  } catch (err) {
    throw new Error(`could not open the desktop file manager: ${(err as Error).message}`);
  }
  if (platform === 'darwin' && result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`could not open the desktop file manager: ${detail}`);
  }
  return command.via;
}

/** Who opens the file manager: the daemon itself, the client application on
 *  the user's desktop, or nobody (the user is told, nothing is claimed). */
export type RevealLane = 'host' | 'client' | 'none';

/**
 * The one decision point between the two ways to show a path. The daemon only
 * launches the file manager when it can prove a desktop is there; otherwise a
 * client that lives in the user's session (the Electron app) is asked to do
 * it, and a plain browser gets an explicit refusal — never a success.
 */
export function chooseRevealLane(input: {
  hostHasGui: boolean;
  hostSession: DesktopSession;
  clientCanOpen: boolean;
}): RevealLane {
  if (input.hostHasGui && input.hostSession === 'graphical') return 'host';
  return input.clientCanOpen ? 'client' : 'none';
}
