/**
 * Where Hermes keeps its agents on the daemon's machine, found by the daemon
 * alone.
 *
 * Exception, stated on purpose: this is the one part of the agent import that
 * reads the disk itself. A third-party plugin has no permission to read files,
 * so the Hermes direct source cannot be rewritten as an unprivileged plugin
 * today; it stays a named exception of this built-in plugin until the SDK
 * offers a "declared readable roots" hook (cadrage, question 4).
 *
 * What keeps it narrow:
 * - the roots are the platform defaults Hermes itself uses — `~/.hermes` on
 *   Linux and macOS, `%LOCALAPPDATA%\hermes` on Windows (or
 *   `<home>\AppData\Local\hermes` when the variable is missing) — and
 *   `profiles/<name>` below them. No path ever comes from a browser: a route
 *   receives profile NAMES and maps them back onto what was detected here;
 * - `HERMES_HOME` is not read. It lives in the user's shell, not in the
 *   environment of a service (systemd, launchd, a Windows task), so relying on
 *   it would detect one thing from a terminal and another from the service;
 * - below the root, nothing is followed: `profiles/` and each profile are
 *   `lstat`ed, a link or a junction is not a profile.
 */
import { lstat, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** Hermes' own grammar for a named profile (`PROFILE_ID_RE`). */
export const HERMES_PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The profile that is the root itself. */
export const HERMES_DEFAULT_PROFILE = 'default';
/** A manifest holds at most 100 agents, the default profile included. */
export const HERMES_MAX_PROFILES = 100;

/** Files that make a folder a Hermes home or profile, rather than a stray folder (`_PROFILE_IDENTITY_MARKERS`). */
const IDENTITY_MARKERS = ['config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db'] as const;
/** Where Hermes leaves a tombstone for a deleted profile, beside the profiles. */
const DELETED_DIR = '.deleted';

export type HermesPlatform = {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
};

export type HermesProfile = {
  /** `default` for the root, the folder name otherwise. */
  name: string;
  /** Absolute path, built by the daemon. Never sent to a browser. */
  root: string;
};

export type HermesInstallation = {
  root: string;
  /** The root as the user knows it (`~/.hermes`, `%LOCALAPPDATA%\hermes`): safe to show. */
  label: string;
  profiles: HermesProfile[];
};

function currentPlatform(): HermesPlatform {
  return { platform: process.platform, env: process.env, home: homedir() };
}

/** The Hermes root this platform would use, or `null` when the home is unknown. */
export function hermesRootCandidate(host: HermesPlatform = currentPlatform()): { root: string; label: string } | null {
  if (host.platform === 'win32') {
    const local = host.env.LOCALAPPDATA?.trim();
    if (local && win32.isAbsolute(local)) return { root: win32.join(local, 'hermes'), label: '%LOCALAPPDATA%\\hermes' };
    if (!host.home || !win32.isAbsolute(host.home)) return null;
    return { root: win32.join(host.home, 'AppData', 'Local', 'hermes'), label: '%USERPROFILE%\\AppData\\Local\\hermes' };
  }
  if (!host.home || !posix.isAbsolute(host.home)) return null;
  return { root: posix.join(host.home, '.hermes'), label: '~/.hermes' };
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function hasIdentity(dir: string, join: (...parts: string[]) => string): Promise<boolean> {
  for (const marker of IDENTITY_MARKERS) {
    if (await exists(join(dir, marker))) return true;
  }
  return false;
}

/**
 * The Hermes installation of this machine with its profiles, or `null`.
 * The root itself may be a link (a dotfiles manager links `~/.hermes`): it is
 * the daemon's own choice. Nothing below it is followed.
 */
export async function detectHermes(host: HermesPlatform = currentPlatform()): Promise<HermesInstallation | null> {
  const candidate = hermesRootCandidate(host);
  if (!candidate) return null;
  const join = host.platform === 'win32' ? win32.join : posix.join;
  try {
    if (!(await stat(candidate.root)).isDirectory()) return null;
  } catch {
    return null;
  }

  const profiles: HermesProfile[] = [];
  if (await hasIdentity(candidate.root, join)) profiles.push({ name: HERMES_DEFAULT_PROFILE, root: candidate.root });

  const profilesDir = join(candidate.root, 'profiles');
  if (await isRealDirectory(profilesDir)) {
    let names: string[] = [];
    try {
      names = (await readdir(profilesDir)).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      if (profiles.length >= HERMES_MAX_PROFILES) break;
      if (!HERMES_PROFILE_RE.test(name) || name === HERMES_DEFAULT_PROFILE) continue;
      const root = join(profilesDir, name);
      if (!(await isRealDirectory(root))) continue;
      if (await exists(join(profilesDir, DELETED_DIR, name))) continue;
      if (!(await hasIdentity(root, join))) continue;
      profiles.push({ name, root });
    }
  }
  if (profiles.length === 0) return null;
  return { root: candidate.root, label: candidate.label, profiles };
}
