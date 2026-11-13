/**
 * What the daemon restricts to its own account at start (TODO #864), and why
 * the rest is left alone. The mechanism lives in `host/owner-only.ts`; this
 * file is only the policy, so it can be read as the list `docs/SECURITY.md`
 * §6.1.1 describes.
 *
 * POSIX: the home itself goes to 0700, which alone shuts every other account
 * out of everything below it (no traversal). The entries listed below are
 * tightened as well, in case the home is opened again by hand or one of them
 * is a symlink to somewhere else. Nothing is walked recursively: `worktrees/`
 * holds whole repositories with their dependencies.
 *
 * Windows: one protected, inherited ACL on the home, plus the same targets
 * checked for an explicit entry of another account (`restrictHomeAclToOwner`).
 * Read and judged at every start, rewritten only when it is wrong.
 *
 * Called from `home-permissions-boot.ts`, before the first SQLite open and
 * before any route (TODO #864).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ZONES } from './paths.js';
import {
  restrictHomeAclToOwner,
  tightenToOwner,
  type OwnerOnlyDeps,
  type OwnerOnlyOutcome,
  type WindowsAclDeps,
} from './host/owner-only.js';

/** SQLite files: the database and the two files it keeps beside it. */
const DATABASES = ['rooks.db', 'integrations.db', 'remote.db'];
const SQLITE_SUFFIXES = ['', '-wal', '-shm', '-journal'];

/**
 * Directories whose direct entries are tightened too:
 * - `backups`: full copies of the database (nightly archives, pre-update snapshots);
 * - `mcp`: MCP server definitions, whose headers and env may carry API keys;
 * - `backends`: provider settings, API keys included;
 * - `backend-accounts`: CLI sign-ins.
 */
const PRIVATE_DIRS = ['backups', 'mcp', 'backends', 'backend-accounts'];

/** `rooks.config.json` and the `.bak*` copies people (and older versions) leave beside it. */
const CONFIG_PREFIX = 'rooks.config.json';

export type HomePermissionsReport = { tightened: string[]; failed: string[] };

/** The paths the sweep restricts, in order, the home first. Exported for the test and the doc. */
export function ownerOnlyTargets(home: string, list: (dir: string) => string[] = safeList): string[] {
  const targets = new Set<string>([home]);
  for (const name of ZONES.secrets) targets.add(join(home, name));
  for (const db of DATABASES) for (const suffix of SQLITE_SUFFIXES) targets.add(join(home, `${db}${suffix}`));
  for (const name of list(home)) if (name.startsWith(CONFIG_PREFIX)) targets.add(join(home, name));
  for (const dir of PRIVATE_DIRS) {
    targets.add(join(home, dir));
    for (const name of list(join(home, dir))) targets.add(join(home, dir, name));
  }
  return [...targets];
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** POSIX part: synchronous, a few dozen `stat`. Never throws. */
export function tightenHome(home: string, deps: OwnerOnlyDeps & { list?: (dir: string) => string[] } = {}): HomePermissionsReport {
  const report: HomePermissionsReport = { tightened: [], failed: [] };
  if ((deps.platform ?? process.platform) === 'win32') return report;
  for (const path of ownerOnlyTargets(home, deps.list)) {
    const outcome: OwnerOnlyOutcome = tightenToOwner(path, deps);
    if (outcome === 'tightened') report.tightened.push(path);
    else if (outcome === 'failed') report.failed.push(path);
  }
  return report;
}

/**
 * Daemon start, synchronous on every OS: when it returns, the home is as
 * restricted as it is going to be. Never throws.
 */
export function hardenHomePermissions(
  home: string,
  deps: OwnerOnlyDeps & { list?: (dir: string) => string[]; windows?: WindowsAclDeps } = {},
): { report: HomePermissionsReport; acl: OwnerOnlyOutcome | null } {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const files = ownerOnlyTargets(home, deps.list).slice(1);
    return { report: { tightened: [], failed: [] }, acl: restrictHomeAclToOwner(home, files, deps.windows) };
  }
  const report = tightenHome(home, deps);
  if (report.tightened.length > 0) {
    console.log(`[perms] restricted to the owner: ${report.tightened.length} path(s) under ${home}`);
  }
  return { report, acl: null };
}
