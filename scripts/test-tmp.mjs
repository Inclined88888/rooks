/**
 * Per-process scratch temp dir for the test suites (orchestrator, app, desktop).
 *
 * Why: ~230 test files call `mkdtempSync(join(tmpdir(), …))` and never delete
 * the result. Every agent runs the suites, so /tmp grew by ~16 G/day. Rather
 * than editing each call site, the preload (`test-tmp-preload.mjs`) points
 * TMPDIR/TMP/TEMP at a dir of its own, then removes it on exit: every
 * `tmpdir()` call — and every child process a test spawns — lands inside.
 *
 * Plain ESM with node built-ins only, so each package can load it with
 * `--import` without depending on another package's toolchain.
 */
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Kept short: macOS caps a Unix socket path (sun_path) at 104 bytes. */
export const ROOT_NAME = 'timon-tests';
/** Older than this and not owned by a live process → left behind by a SIGKILL. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
/** Owner-only: test homes hold fake secrets, and the root is shared /tmp. */
const PRIVATE_MODE = 0o700;

/** @param {number} pid */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

/**
 * Creates `root` if needed, then refuses it unless it is a real directory
 * (never a symlink) and, on POSIX, owned by the current uid. Without that, a
 * user who planted `<tmp>/timon-tests` — or a symlink there — first would
 * receive our test files and steer the sweep's `rmSync` onto their target.
 * An existing root of ours is narrowed back to 0700. uid and mode do not
 * exist on Windows: there the per-user %TEMP% already provides the isolation.
 * @param {string} root
 * @param {{ uid?: number }} [opts] uid override, for tests only
 */
export function ensureRoot(root, opts = {}) {
  try {
    mkdirSync(root, { mode: PRIVATE_MODE });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
  }
  const st = lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`test scratch root ${root} is not a real directory; remove it and rerun`);
  }
  const uid = opts.uid ?? process.getuid?.();
  if (uid === undefined) return;
  if (st.uid !== uid) {
    throw new Error(`test scratch root ${root} belongs to uid ${st.uid}, not ${uid}; remove it and rerun`);
  }
  if ((st.mode & 0o777) !== PRIVATE_MODE) chmodSync(root, PRIVATE_MODE);
}

/**
 * Removes the scratch dirs a killed process could not clean (SIGKILL runs no
 * handler). Only direct children of `root` are considered, never anything
 * outside it. A recent dir, or one whose owning pid is still alive, is kept.
 * @param {string} root
 * @param {{ maxAgeMs?: number, now?: number, keep?: string }} [opts]
 * @returns {string[]} names of the removed entries
 */
export function sweepStale(root, opts = {}) {
  const maxAgeMs = opts.maxAgeMs ?? STALE_AFTER_MS;
  const now = opts.now ?? Date.now();
  const removed = [];
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (name === opts.keep) continue;
    const full = join(root, name);
    try {
      if (now - lstatSync(full).mtimeMs <= maxAgeMs) continue;
      if (isAlive(Number.parseInt(name.split('-')[0] ?? '', 10))) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Raced with another process's sweep or cleanup: nothing to do.
    }
  }
  return removed;
}

/**
 * Creates `<realTmp>/timon-tests/<pid>-<random>` (0700) and redirects the
 * three variables `os.tmpdir()` reads (TMPDIR on POSIX, TEMP/TMP on Windows).
 * Throws, before touching anything, if the root fails `ensureRoot`.
 * @param {{ realTmp?: string, uid?: number }} [opts]
 * @returns {{ root: string, dir: string, cleanup: () => void }}
 */
export function setupScratch(opts = {}) {
  const root = join(opts.realTmp ?? tmpdir(), ROOT_NAME);
  const dir = join(root, `${process.pid}-${randomBytes(3).toString('hex')}`);
  ensureRoot(root, { uid: opts.uid });
  // Non-recursive on purpose: the root was just vetted, nothing else is created.
  mkdirSync(dir, { mode: PRIVATE_MODE });
  sweepStale(root, { keep: dir.slice(root.length + 1) });
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A file still held open (Windows) must not turn a green run red.
    }
  };
  return { root, dir, cleanup };
}
