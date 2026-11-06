/**
 * Owner-only permissions for what Timon keeps under its home (TODO #864): the
 * database holds password hashes, sessions and sealed secrets, and was left
 * world-readable (0644) by SQLite's default creation mode.
 *
 * POSIX (Linux, macOS): permissions are only ever TIGHTENED. The group and
 * other bits are cleared, the owner bits are kept as they are, so a file the
 * user set to 0400 stays 0400 and nothing is ever opened wider than it was.
 *
 * Windows: modes mean nothing there, the lever is the ACL of the home
 * directory itself: a protected DACL granting the current account and
 * LocalSystem only, inherited by every file created inside afterwards
 * (SQLite's `-wal` / `-shm` included, recreated at each open). It is READ at
 * every start, in SDDL, and rewritten whenever it is not exactly that, so an
 * ACL widened since the last start is caught at the next one. A bounded list of
 * secret-bearing files is checked too: an explicit ACE on a file survives any
 * ACL of its parent.
 *
 * Every function here tolerates failure: a filesystem without permissions
 * (FAT, some network mounts) must not keep the daemon from starting. The
 * failure is logged once, in English, and the caller carries on.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, openSync, statSync, type Stats } from 'node:fs';
import type { ExecResult } from './types.js';

export type OwnerOnlyOutcome = 'tightened' | 'unchanged' | 'missing' | 'skipped' | 'failed';

export type OwnerOnlyDeps = {
  platform?: NodeJS.Platform;
  stat?: (path: string) => Stats;
  chmod?: (path: string, mode: number) => void;
  warn?: (message: string) => void;
};

const GROUP_AND_OTHER = 0o077;

/** The mode `tightenToOwner` would leave: never a bit more than `mode` had. */
export function ownerOnlyMode(mode: number): number {
  return mode & 0o7777 & ~GROUP_AND_OTHER;
}

/**
 * Clears the group and other bits of `path` (file or directory). Missing paths
 * are not an error: most of what the sweep names is optional.
 */
export function tightenToOwner(path: string, deps: OwnerOnlyDeps = {}): OwnerOnlyOutcome {
  if ((deps.platform ?? process.platform) === 'win32') return 'skipped';
  const stat = deps.stat ?? statSync;
  const chmod = deps.chmod ?? chmodSync;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  let current: number;
  try {
    current = stat(path).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    warn(`[perms] cannot read the permissions of ${path}: ${(error as Error).message}`);
    return 'failed';
  }
  if ((current & GROUP_AND_OTHER) === 0) return 'unchanged';
  try {
    chmod(path, ownerOnlyMode(current));
    return 'tightened';
  } catch (error) {
    warn(`[perms] cannot restrict ${path} to its owner: ${(error as Error).message}`);
    return 'failed';
  }
}

/**
 * Makes sure `path` exists as an owner-only file BEFORE anything else creates
 * it with a wider default, then tightens it if it already existed. SQLite gives
 * the `-wal` and `-shm` files it creates the mode of the database file, so a
 * database prepared here gets owner-only companions too.
 * Flag `wx`: an existing file is never opened, so neither truncated nor
 * refused for lacking write access (a 0444 one, or one a root container
 * created); it is tightened all the same.
 */
export function prepareOwnerOnlyFile(path: string, deps: OwnerOnlyDeps = {}): OwnerOnlyOutcome {
  if ((deps.platform ?? process.platform) === 'win32') return 'skipped';
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      (deps.warn ?? ((message: string) => console.warn(message)))(
        `[perms] cannot create ${path} owner-only: ${(error as Error).message}`,
      );
      return 'failed';
    }
  }
  return tightenToOwner(path, deps);
}

// --- Windows -------------------------------------------------------------

/** `S-1-5-18`: LocalSystem. Kept, see `docs/SECURITY.md` §6.1.1. */
export const WINDOWS_SYSTEM_SID = 'S-1-5-18';

/**
 * Synchronous on purpose: the check runs before the first SQLite open and
 * before any route, at a point of the boot where nothing else is waiting on
 * the event loop (`home-permissions-boot.ts`).
 */
export type SyncExec = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number }) => ExecResult;

export type WindowsAclDeps = {
  exec?: SyncExec;
  warn?: (message: string) => void;
  log?: (message: string) => void;
  /** Bounds one read of the ACLs. */
  readTimeoutMs?: number;
  /**
   * Bounds the rewrite, propagation to the existing tree included. The whole
   * step must stay well under the desktop's boot budget (90 s embedded): a
   * propagation cut short is finished by the file check of the next start.
   */
  applyTimeoutMs?: number;
};

const READ_TIMEOUT_MS = 10_000;
/** LocalSystem, LocalService, NetworkService. */
const SERVICE_ACCOUNTS = new Set([WINDOWS_SYSTEM_SID, 'S-1-5-19', 'S-1-5-20']);
const APPLY_TIMEOUT_MS = 45_000;

/** Windows PowerShell 5.1, present on every supported Windows; `-EncodedCommand` spares any quoting. */
const defaultExec: SyncExec = (file, args, opts) => {
  const res = spawnSync(file, args, { env: opts.env, timeout: opts.timeout, windowsHide: true, encoding: 'utf8' });
  const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  if (res.error && !timedOut) throw res.error;
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ...(timedOut ? { timedOut: true } : {}) };
};

function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/*
 * Paths travel through the environment (UTF-16 on Windows) and come back as
 * indices: the console code page would mangle a non-ASCII profile path, SDDL
 * itself is ASCII. `-` marks a missing path, `!` an unreadable ACL.
 */
const READ_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::Out.WriteLine([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)',
  '$i = 0',
  'foreach ($p in ($env:TIMON_ACL_PATHS -split "`n")) {',
  "  $s = '-'",
  '  if ($p -and (Test-Path -LiteralPath $p)) { try { $s = (Get-Acl -LiteralPath $p).Sddl } catch { $s = \'!\' } }',
  '  if (-not $s) { $s = \'!\' }',
  '  [Console]::Out.WriteLine("$i`t$s")',
  '  $i++',
  '}',
].join('\n');

/*
 * The home's DACL is REPLACED by the canonical one (explicit ACEs of any other
 * account go with it) through SetNamedSecurityInfo, which propagates the
 * inherited entries to the existing tree. Then each listed file loses its
 * explicit entries and inherits again (`icacls /reset`).
 */
const APPLY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$failed = $false',
  'if ($env:TIMON_ACL_SDDL) {',
  '  $d = New-Object System.Security.AccessControl.DirectorySecurity',
  '  $d.SetSecurityDescriptorSddlForm($env:TIMON_ACL_SDDL, [System.Security.AccessControl.AccessControlSections]::Access)',
  '  [System.IO.Directory]::SetAccessControl($env:TIMON_ACL_HOME, $d)',
  '}',
  'foreach ($f in ($env:TIMON_ACL_RESET -split "`n")) {',
  '  if (-not $f) { continue }',
  "  & icacls.exe $f '/reset' '/Q' | Out-Null",
  '  if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("icacls /reset exited $LASTEXITCODE"); $failed = $true }',
  '}',
  'if ($failed) { exit 2 }',
].join('\n');

export type SddlAce = { type: string; flags: string[]; rights: string; trustee: string };

/** The DACL of an SDDL string; `null` when there is none (a NULL DACL grants everyone everything). */
export function parseDacl(sddl: string): { flags: string; aces: SddlAce[] } | null {
  const m = /D:([A-Z_]*)((?:\([^()]*\))*)/.exec(sddl);
  if (!m || m[1]!.includes('NO_ACCESS_CONTROL')) return null;
  // Fail closed: an entry this parser cannot read (a conditional ACE carries its own
  // parentheses) must not hide the entries after it.
  const rest = sddl.slice(m.index + m[0].length);
  if (rest !== '' && !rest.startsWith('S:')) return null;
  const aces: SddlAce[] = [];
  for (const raw of m[2]!.matchAll(/\(([^()]*)\)/g)) {
    const parts = raw[1]!.split(';');
    if (parts.length < 6) return null;
    aces.push({
      type: parts[0]!,
      flags: parts[1]!.match(/.{2}/g) ?? [],
      rights: parts[2]!,
      trustee: parts[5]!.toUpperCase(),
    });
  }
  return { flags: m[1]!, aces };
}

const FULL_CONTROL = new Set(['FA', 'GA', '0X1F01FF', '0X10000000']);

function allowedTrustee(trustee: string, sid: string): boolean {
  return trustee === sid.toUpperCase() || trustee === 'SY' || trustee === WINDOWS_SYSTEM_SID;
}

/** The DACL `restrictHomeAclToOwner` writes on the home. */
export function ownerOnlyDirSddl(sid: string): string {
  return `D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`;
}

/**
 * Exactly what `ownerOnlyDirSddl` writes, whatever the order: protected, no
 * inherited entry, an inheritable full-control allow for the account, and
 * nothing for any other trustee (`WD`, `BU`, `AU`, `BA`, `CO`, a domain group…).
 */
export function isOwnerOnlyDirDacl(sddl: string, sid: string): boolean {
  const dacl = parseDacl(sddl);
  if (!dacl || !dacl.flags.includes('P')) return false;
  let owner = false;
  for (const ace of dacl.aces) {
    if (ace.type !== 'A' || !allowedTrustee(ace.trustee, sid)) return false;
    if (ace.flags.length !== 2 || !ace.flags.includes('OI') || !ace.flags.includes('CI')) return false;
    if (!FULL_CONTROL.has(ace.rights.toUpperCase())) return false;
    if (ace.trustee === sid.toUpperCase()) owner = true;
  }
  return owner;
}

/** True when any entry, inherited or explicit, grants or denies a trustee other than the account and LocalSystem. */
export function hasForeignAce(sddl: string, sid: string): boolean {
  const dacl = parseDacl(sddl);
  if (!dacl) return true;
  return dacl.aces.some((ace) => !allowedTrustee(ace.trustee, sid));
}

type AclSnapshot = { sid: string; sddl: (string | null)[] };

function readAcls(paths: string[], deps: WindowsAclDeps, exec: SyncExec): AclSnapshot | string {
  const res = exec('powershell.exe', powershellArgs(READ_SCRIPT), {
    env: { ...process.env, TIMON_ACL_PATHS: paths.join('\n') },
    timeout: deps.readTimeoutMs ?? READ_TIMEOUT_MS,
  });
  if (res.timedOut) return 'reading the ACLs timed out';
  if (res.code !== 0) return `reading the ACLs failed (exit ${res.code})`;
  const lines = res.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sid = /^S-1-\d+(?:-\d+)+$/.test(lines[0] ?? '') ? lines[0]! : null;
  if (!sid) return 'cannot resolve the current Windows account';
  const sddl: (string | null)[] = paths.map(() => null);
  for (const line of lines.slice(1)) {
    const m = /^(\d+)\t(.*)$/.exec(line);
    if (!m) continue;
    const index = Number(m[1]);
    if (index < paths.length) sddl[index] = m[2] === '-' ? null : m[2]!;
  }
  return { sid, sddl };
}

type AclPlan = { dir: boolean; reset: string[]; unreadable: string[] };

function planOf(home: string, files: string[], snap: AclSnapshot): AclPlan {
  const dirSddl = snap.sddl[0] ?? null;
  const plan: AclPlan = { dir: false, reset: [], unreadable: [] };
  if (dirSddl === null || dirSddl === '!') plan.unreadable.push(home);
  else if (!isOwnerOnlyDirDacl(dirSddl, snap.sid)) plan.dir = true;
  files.forEach((file, i) => {
    const sddl = snap.sddl[i + 1] ?? null;
    if (sddl === null) return;
    if (sddl === '!') plan.unreadable.push(file);
    else if (hasForeignAce(sddl, snap.sid)) plan.reset.push(file);
  });
  return plan;
}

/**
 * Checks, and restores when needed, the owner-only ACL of `home` and of the
 * listed `files` (missing ones are skipped). Runs at EVERY start: nothing is
 * remembered, the ACL actually in place is what is judged. Never throws; a
 * failure is one log line and the daemon carries on.
 */
export function restrictHomeAclToOwner(home: string, files: string[], deps: WindowsAclDeps = {}): OwnerOnlyOutcome {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const exec = deps.exec ?? defaultExec;
  const paths = [home, ...files];
  try {
    const before = readAcls(paths, deps, exec);
    if (typeof before === 'string') {
      warn(`[perms] ${before}, ${home} keeps its current ACL`);
      return 'failed';
    }
    if (SERVICE_ACCOUNTS.has(before.sid)) {
      // The task runs as the signed-in user (S4U); granting a service account alone would lock that user out.
      warn(`[perms] the daemon runs as a service account (${before.sid}), ${home} keeps its current ACL`);
      return 'failed';
    }
    const plan = planOf(home, files, before);
    if (plan.unreadable.includes(home)) {
      // FAT, some network shares: no ACL to set.
      warn(`[perms] cannot read the ACL of ${home}, it is left as it is`);
      return 'failed';
    }
    if (plan.unreadable.length > 0) warn(`[perms] cannot read the ACL of ${plan.unreadable.length} path(s) under ${home}, they are not checked`);
    if (!plan.dir && plan.reset.length === 0) return 'unchanged';
    const res = exec('powershell.exe', powershellArgs(APPLY_SCRIPT), {
      env: {
        ...process.env,
        TIMON_ACL_HOME: home,
        TIMON_ACL_SDDL: plan.dir ? ownerOnlyDirSddl(before.sid) : '',
        TIMON_ACL_RESET: plan.reset.join('\n'),
      },
      timeout: deps.applyTimeoutMs ?? APPLY_TIMEOUT_MS,
    });
    if (res.timedOut) warn(`[perms] restricting ${home} to its owner timed out, the next start carries on`);
    else if (res.code !== 0) warn(`[perms] restricting ${home} to its owner failed (exit ${res.code})${res.stderr.trim() ? `: ${res.stderr.trim()}` : ''}`);
    // The result is judged on what is now in place, not on the exit code.
    const after = readAcls(paths, deps, exec);
    if (typeof after === 'string') {
      warn(`[perms] ${after} after the change, ${home} may keep a wider ACL`);
      return 'failed';
    }
    const left = planOf(home, files, after);
    if (left.dir || left.reset.length > 0) {
      warn(`[perms] ${[...(left.dir ? [home] : []), ...left.reset].length} path(s) under ${home} still grant another account`);
      return 'failed';
    }
    (deps.log ?? ((message: string) => console.log(message)))(`[perms] ${home} restricted to its owner (ACL)`);
    return 'tightened';
  } catch (error) {
    warn(`[perms] cannot restrict ${home} to its owner: ${(error as Error).message}`);
    return 'failed';
  }
}
