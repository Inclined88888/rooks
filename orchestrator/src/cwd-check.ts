/**
 * `stat` + errno classification of a working directory, shared by the project
 * statuses (`project-cwd.ts`) and the agent cwd readers (`git.ts`, `files.ts`).
 * A leaf: no database, no registry, so those readers can use it as they are.
 */
import { statSync, type Stats } from 'node:fs';

/** Why a registered cwd cannot be used. A project with no cwd at all is not an
 *  error: its report carries `cwd_error: null` and `cwd_path: null`. */
export type CwdError = 'missing' | 'denied' | 'not-a-directory';

/** The cwd fields every project status carries next to its own `cwd`.
 *  `cwd` stays "the usable cwd" (consumers spawn and compose from it);
 *  `cwd_path` is what the project has registered, usable or not. */
export type CwdReport = {
  cwd_path: string | null;
  cwd_error: CwdError | null;
  /** The raw errno (`EPERM`, `ENOENT`…), `NOT_A_DIRECTORY` when the path is a file. */
  cwd_code: string | null;
};

export type CwdCheck = { ok: true } | { ok: false; error: CwdError; code: string };

/** What the daemon last logged per path: statuses are polled every few seconds
 *  per card, a line per poll would drown daemon.log. */
const lastLogged = new Map<string, string>();
const LAST_LOGGED_MAX = 200;

function logTransition(path: string, outcome: string): void {
  if (lastLogged.get(path) === outcome) return;
  // A path that was fine and has never failed is not worth a line.
  if (outcome === 'ok' && !lastLogged.has(path)) return;
  if (lastLogged.size >= LAST_LOGGED_MAX) lastLogged.clear();
  lastLogged.set(path, outcome);
  console.warn(`[projects] cwd ${path} → ${outcome}`);
}

/** `stat` + errno classification. `stat` is injectable: EPERM cannot be
 *  produced reliably from a test. */
export function checkCwd(path: string, stat: (path: string) => Stats = statSync): CwdCheck {
  let info: Stats;
  try {
    info = stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    logTransition(path, code);
    if (code === 'EPERM' || code === 'EACCES') return { ok: false, error: 'denied', code };
    if (code === 'ENOTDIR') return { ok: false, error: 'not-a-directory', code };
    // ENOENT, but also ELOOP / ENAMETOOLONG / EIO: nothing usable at that
    // address. The raw code stays in the report and in the log.
    return { ok: false, error: 'missing', code };
  }
  if (!info.isDirectory()) {
    logTransition(path, 'NOT_A_DIRECTORY');
    return { ok: false, error: 'not-a-directory', code: 'NOT_A_DIRECTORY' };
  }
  logTransition(path, 'ok');
  return { ok: true };
}

/**
 * What to answer for a cwd that cannot be used, errno kept, or null when it
 * can: an `existsSync` said "not found" for a folder the OS only refused (a
 * protected macOS folder), and the user went looking for a folder that was there.
 */
export function cwdProblem(path: string, stat: (path: string) => Stats = statSync): string | null {
  const check = checkCwd(path, stat);
  if (check.ok) return null;
  if (check.error === 'denied') return `cwd access denied (${check.code})`;
  if (check.error === 'not-a-directory') return 'cwd is not a directory';
  return 'cwd not found';
}
