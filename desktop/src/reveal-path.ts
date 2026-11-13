import { posix, win32 } from 'node:path';

export const REVEAL_PATH_CHANNEL = 'rooks:reveal-path';

const MAX_PATH_LENGTH = 4096;
const MAX_AGENT_LENGTH = 200;

/** What the renderer is told; mirrors `RevealOutcome` in `app/src/lib/reveal-entry.ts`. */
export type RevealOutcome =
  | { status: 'opened' }
  | { status: 'no-desktop' }
  | { status: 'failed'; message: string | null };

export type RevealPathDeps = {
  platform: NodeJS.Platform;
  /** The app's reveal route, called by this process with the user's session —
   *  never with a daemon token. `body` is null when the reply is not JSON. */
  callRoute: (agentId: string, path: string) => Promise<{ status: number; body: unknown }>;
  /** `null` when the path does not exist. */
  stat: (path: string) => { isDirectory(): boolean } | null;
  /** Throws when the path cannot be resolved. */
  realpath: (path: string) => string;
  exists: (path: string) => boolean;
  showItemInFolder: (path: string) => void;
  /** Electron's `shell.openPath`: resolves with an error message, '' on success. */
  openPath: (path: string) => Promise<string>;
};

type RouteReply = { kind?: unknown; absolutePath?: unknown; error?: unknown; code?: unknown };

/**
 * Whether a directory may be handed to `shell.openPath`. On macOS a bundle is a
 * directory and `NSWorkspace.openURL` launches it, so only a folder with no
 * extension — by its own name and by the one a link resolves to — and no
 * `Contents/Info.plist` is opened; everything else is selected in its parent.
 * Same rule as `opensAsFolder` in `orchestrator/src/host/reveal.ts` (the two
 * packages are independent). Elsewhere a directory is never executed.
 */
function opensAsFolder(path: string, deps: RevealPathDeps): boolean {
  if (deps.platform !== 'darwin') return true;
  let resolved: string;
  try { resolved = deps.realpath(path); } catch { return false; }
  return [path, resolved].every((p) => (
    posix.extname(posix.basename(p)) === ''
    && !deps.exists(posix.join(p, 'Contents', 'Info.plist'))
  ));
}

/** Shows a path the daemon returned (already confined to an agent folder). */
async function showLocalPath(path: string, deps: RevealPathDeps): Promise<RevealOutcome> {
  const flavor = deps.platform === 'win32' ? win32 : posix;
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes('\0') || !flavor.isAbsolute(path)) {
    return { status: 'failed', message: 'Invalid path.' };
  }
  // `\\host\share` and `\\?\…` make Windows authenticate against a remote
  // machine (credential leak); a local agent folder is never one of them.
  if (deps.platform === 'win32' && /^[\\/]{2}/.test(path)) return { status: 'failed', message: 'Invalid path.' };

  const stat = deps.stat(path);
  if (!stat) return { status: 'failed', message: 'Path not found.' };
  // `shell.openPath` on a file executes it with its default handler (`.exe`,
  // `.bat`, `.lnk`), and on a macOS bundle it launches it: both are only ever
  // selected. "Directory" is read from the disk, not from the reply.
  if (stat.isDirectory() && opensAsFolder(path, deps)) {
    const failure = await deps.openPath(path);
    return failure ? { status: 'failed', message: failure } : { status: 'opened' };
  }
  deps.showItemInFolder(path);
  return { status: 'opened' };
}

/**
 * "Show in system explorer" for a daemon that has no desktop session (Windows
 * service in session 0, macOS LaunchDaemon): the daemon cannot show anything,
 * this process lives in the user's session and can.
 *
 * The renderer is NOT trusted with a filesystem path. It names an agent and a
 * path inside that agent's folder; this process asks the app's reveal route —
 * with the user's session cookie, so the daemon applies the same confinement
 * and access checks as for any other request — and shows only the absolute
 * path that route answers. An absolute path supplied by the renderer is never
 * read: there is no field for it, and the one in the IPC payload is the
 * relative one the daemon resolves.
 */
export async function revealEntry(
  sender: { isWindow: boolean; isMainFrame: boolean; url: string },
  uiOrigin: string,
  input: unknown,
  deps: RevealPathDeps,
): Promise<RevealOutcome> {
  let trusted = false;
  try {
    trusted = sender.isWindow && sender.isMainFrame
      && new URL(sender.url).origin === new URL(uiOrigin).origin;
  } catch { /* Reject malformed or missing frame URLs. */ }
  if (!trusted) throw new Error('Showing a path is only available from Rooks.');

  const { agentId, path } = (input && typeof input === 'object' ? input : {}) as { agentId?: unknown; path?: unknown };
  if (
    typeof agentId !== 'string' || agentId.length === 0 || agentId.length > MAX_AGENT_LENGTH
    || typeof path !== 'string' || path.length > MAX_PATH_LENGTH
    || agentId.includes('\0') || path.includes('\0')
  ) {
    throw new Error('Invalid path.');
  }

  let reply: { status: number; body: unknown };
  try {
    reply = await deps.callRoute(agentId, path);
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
  const body = (reply.body && typeof reply.body === 'object' ? reply.body : {}) as RouteReply;
  if (reply.status < 200 || reply.status >= 300) {
    if (body.code === 'no_desktop_session') return { status: 'no-desktop' };
    return { status: 'failed', message: typeof body.error === 'string' ? body.error : null };
  }
  if (body.kind === 'revealed') return { status: 'opened' };
  if (body.kind === 'client' && typeof body.absolutePath === 'string') {
    return showLocalPath(body.absolutePath, deps);
  }
  return { status: 'failed', message: null };
}
