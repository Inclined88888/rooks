/**
 * The one place that answers "can the daemon use this project's working
 * directory?" (TIM-0083).
 *
 * `existsSync` folded every failure — ENOENT, EPERM/EACCES, ENOTDIR — into
 * "absent", so a folder the daemon was merely refused (a protected macOS
 * folder, an unmounted volume) showed up as "no working directory" with no
 * trace of the reason. A `stat` keeps the errno, which is what lets the UI say
 * *why* and daemon.log say which code the OS returned.
 */
import { readMeta } from './projects.js';
import { checkCwd, type CwdReport } from './cwd-check.js';

export { checkCwd, type CwdCheck, type CwdError, type CwdReport } from './cwd-check.js';

export type ProjectCwd = CwdReport & {
  /** The registered cwd when the daemon can use it, null otherwise. */
  cwd: string | null;
};

/** A project's cwd, only if the daemon can really reach it as a directory.
 *  Throws on an unknown/invalid slug, like `readMeta` — callers rely on it. */
export function resolveProjectCwd(slug: string): ProjectCwd {
  const registered = readMeta(slug).cwd;
  if (!registered) return { cwd: null, cwd_path: null, cwd_error: null, cwd_code: null };
  const check = checkCwd(registered);
  if (check.ok) return { cwd: registered, cwd_path: registered, cwd_error: null, cwd_code: null };
  return { cwd: null, cwd_path: registered, cwd_error: check.error, cwd_code: check.code };
}

/** The report of an already usable cwd (no check, no log). */
export function usableReport(cwd: string): CwdReport {
  return { cwd_path: cwd, cwd_error: null, cwd_code: null };
}

export function reportOf(resolved: ProjectCwd): CwdReport {
  return { cwd_path: resolved.cwd_path, cwd_error: resolved.cwd_error, cwd_code: resolved.cwd_code };
}
