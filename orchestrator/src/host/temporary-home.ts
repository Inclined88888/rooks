/**
 * A service whose data directory sits in the OS temporary folder (TODO #464).
 *
 * Release-candidate tests run Rooks on `ROOKS_HOME=$(mktemp -d)`. A service
 * installed there outlives the test: on 25/10/2026 the build machine carried
 * eight `rooks-desktop-<hash>` units, each pointing at a deleted home under
 * `/tmp`, restarting on failure at every session (27 processes, ~2.1 GB). The
 * OS also empties that folder on its own (reboot, `systemd-tmpfiles`, macOS
 * periodic cleanup), so such a service is broken by design, not by accident.
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve, isAbsolute } from 'node:path';

/** What lets `rooks service install` write a service for a temporary home anyway. */
export const ALLOW_TEMPORARY_HOME_FLAG = '--allow-temp-home';

export type TemporaryHomeOptions = {
  platform?: NodeJS.Platform;
  /** The OS temporary folder; tests point it elsewhere. */
  tmp?: string;
  /** Resolves links (`/var` → `/private/var` on macOS); `null` when the path does not exist. */
  realpath?: (path: string) => string | null;
};

function realOrNull(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function inside(parent: string, child: string, platform: NodeJS.Platform): boolean {
  // Windows and macOS compare paths without case by default.
  const fold = (value: string) => (platform === 'linux' ? value : value.toLowerCase());
  const rel = relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Is `home` the OS temporary folder or somewhere below it? */
export function underTemporaryDir(home: string, opts: TemporaryHomeOptions = {}): boolean {
  const platform = opts.platform ?? process.platform;
  const realpath = opts.realpath ?? realOrNull;
  const tmp = resolve(opts.tmp ?? tmpdir());
  const target = resolve(home);
  const parents = [tmp, realpath(tmp)].filter((p): p is string => Boolean(p));
  const homes = [target, realpath(target)].filter((p): p is string => Boolean(p));
  return parents.some((parent) => homes.some((candidate) => inside(parent, candidate, platform)));
}

/**
 * The refusal `rooks service install` prints, or `null` when the home is not
 * temporary. With `allowed`, the same words as a warning that does not stop.
 */
export function temporaryHomeNotice(
  home: string,
  allowed: boolean,
  opts: TemporaryHomeOptions = {},
): { refuse: boolean; lines: string[] } | null {
  if (!underTemporaryDir(home, opts)) return null;
  const warning = `warning: ROOKS_HOME (${home}) is inside the system temporary folder (${opts.tmp ?? tmpdir()}). `
    + 'A service installed for it keeps restarting once that folder is emptied.';
  if (allowed) {
    return { refuse: false, lines: [warning, 'remove it at the end of the test: rooks service uninstall (same ROOKS_HOME)'] };
  }
  return {
    refuse: true,
    lines: [warning, `refused: pass ${ALLOW_TEMPORARY_HOME_FLAG} to install it anyway, and run rooks service uninstall with the same ROOKS_HOME when done.`],
  };
}
