import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { win32 } from 'node:path';
import { prepareSpeechModelsDir, speechModelsDirPlan, type SpeechModelsCandidate } from './speech-paths.js';

/**
 * Locks down a machine-wide models folder before dictation trusts it
 * (TODO #445).
 *
 * On Windows, a home with a non-ASCII character sends the models to
 * `%ProgramData%\Rooks\speech-models\<hash of the home>`. Every account may
 * create folders under ProgramData, and the hash is predictable: another
 * account could create that folder first, fill it with a fake model whose
 * marker copies the public catalog, and stay its owner (so it could also swap
 * the files later). Re-hashing the files does not close that race; owning the
 * folder does. So:
 *
 *   - every folder between the root and the models folder must be a real
 *     directory (no junction) owned by this account or by the system;
 *   - the models folder itself must be owned by us, with a protected ACL that
 *     grants only this account, SYSTEM and Administrators;
 *   - a folder we own but left open (older build, interrupted setup) is
 *     deleted and created again, empty, then restricted with `icacls`;
 *   - a folder owned by another account is refused: the caller moves on to
 *     the next candidate (ultimately the home), and downloads there.
 *
 * Pure decision logic over an injected probe and filesystem, so the Windows
 * branch is tested on any OS.
 */

export const SID_SYSTEM = 'S-1-5-18';
export const SID_ADMINISTRATORS = 'S-1-5-32-544';
const SID_TRUSTED_INSTALLER = 'S-1-5-80-956008885-3425200536-1222206990-4250006690-3536300218';

export type AclEntry = { sid: string; allow: boolean; inherited: boolean };

export type PathSecurity =
  | { exists: false }
  | { exists: true; directory: boolean; reparse: boolean; owner: string | null; protected: boolean; entries: AclEntry[] };

export type SecuritySnapshot = { user: string; items: PathSecurity[] };

export interface SecurityProbe {
  /** Owner and ACL of each path, in order, plus the SID of the current account. */
  inspect(paths: readonly string[]): Promise<SecuritySnapshot>;
  /** Drops inherited entries and grants full control to `userSid` and SYSTEM only. */
  restrict(dir: string, userSid: string): Promise<void>;
}

export interface GuardFs {
  mkdir(dir: string, options: { recursive: boolean }): Promise<unknown>;
  rm(dir: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
}

export class SharedDirRefused extends Error {}

const nodeFs: GuardFs = {
  mkdir: (dir, options) => mkdir(dir, options),
  // `maxRetries`: an antivirus or indexer may still hold a file on Windows.
  rm: (dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  readdir: (dir) => readdir(dir),
};

/** The folders from just under `root` down to `dir`, outermost first. */
export function guardedChain(root: string, dir: string): string[] {
  const rel = win32.relative(root, dir);
  if (!rel || rel.startsWith('..') || win32.isAbsolute(rel)) {
    throw new SharedDirRefused('the models folder is not under its root');
  }
  const chain: string[] = [];
  let current = win32.resolve(root);
  for (const part of rel.split(win32.sep)) {
    current = win32.join(current, part);
    chain.push(current);
  }
  return chain;
}

/** Owners an attacker without admin rights cannot forge. */
function trustedOwner(owner: string | null, user: string): boolean {
  return owner === user || owner === SID_SYSTEM || owner === SID_ADMINISTRATORS || owner === SID_TRUSTED_INSTALLER;
}

function plainDirectory(item: PathSecurity): item is Extract<PathSecurity, { exists: true }> {
  return item.exists && item.directory && !item.reparse;
}

/** Owned by us (or by the admin group an elevated Rooks creates as), and closed to every other account. */
export function lockedDown(item: PathSecurity, user: string): boolean {
  if (!plainDirectory(item) || !trustedOwner(item.owner, user) || item.owner === SID_TRUSTED_INSTALLER) return false;
  if (!item.protected) return false;
  const allowed = new Set([user, SID_SYSTEM, SID_ADMINISTRATORS]);
  // Deny entries only take rights away: harmless here.
  return item.entries.every((entry) => !entry.allow || (!entry.inherited && allowed.has(entry.sid)));
}

function checkParents(chain: readonly string[], snapshot: SecuritySnapshot): void {
  for (let i = 0; i < chain.length - 1; i += 1) {
    const item = snapshot.items[i];
    if (!item) throw new SharedDirRefused('incomplete security probe');
    if (!item.exists) continue;
    if (!plainDirectory(item)) throw new SharedDirRefused(`${chain[i]} is not a plain folder`);
    if (!trustedOwner(item.owner, snapshot.user)) throw new SharedDirRefused(`${chain[i]} belongs to another account`);
  }
}

/**
 * Whether uninstall may delete the models folder probed last in `snapshot`
 * (TODO #444): the same ownership `ensureSharedSpeechDir` requires to use it.
 * A folder another account created first is not ours: it is neither used nor
 * deleted. A missing folder has nothing to delete.
 */
export function sharedSpeechDirRemovable(snapshot: SecuritySnapshot): boolean {
  const leaf = snapshot.items.at(-1);
  if (!leaf || !plainDirectory(leaf) || !trustedOwner(leaf.owner, snapshot.user) || leaf.owner === SID_TRUSTED_INSTALLER) return false;
  return snapshot.items.slice(0, -1).every((item) => !item.exists || (plainDirectory(item) && trustedOwner(item.owner, snapshot.user)));
}

/**
 * Makes `dir` (under the machine-wide `root`) safe to hold the models, or
 * throws `SharedDirRefused`/an I/O error so the caller tries the next place.
 */
export async function ensureSharedSpeechDir(
  root: string,
  dir: string,
  probe: SecurityProbe,
  fs: GuardFs = nodeFs,
  log: (message: string) => void = () => undefined,
): Promise<void> {
  const chain = guardedChain(root, dir);
  const leafIndex = chain.length - 1;

  const before = await probe.inspect(chain);
  checkParents(chain, before);
  const leaf = before.items[leafIndex];
  if (!leaf) throw new SharedDirRefused('incomplete security probe');
  if (lockedDown(leaf, before.user)) return;
  if (leaf.exists) {
    // Ours but open to other accounts: what it holds cannot be trusted.
    if (!plainDirectory(leaf) || !trustedOwner(leaf.owner, before.user) || leaf.owner === SID_TRUSTED_INSTALLER) {
      throw new SharedDirRefused(`${dir} belongs to another account`);
    }
    log(`[speech] models folder ${dir} was not restricted to this account: deleting it, the model will be downloaded again`);
    await fs.rm(dir);
  }

  await fs.mkdir(win32.dirname(dir), { recursive: true });
  // Not recursive: if another account created it in between, this fails (EEXIST).
  await fs.mkdir(dir, { recursive: false });
  try {
    await probe.restrict(dir, before.user);
    const after = await probe.inspect(chain);
    checkParents(chain, after);
    const created = after.items[leafIndex];
    if (!created || !lockedDown(created, after.user)) throw new SharedDirRefused(`${dir} could not be restricted to this account`);
    // Between our mkdir and the ACL, the inherited ACL let other accounts add entries.
    if ((await fs.readdir(dir)).length > 0) throw new SharedDirRefused(`${dir} received files from another account while it was created`);
  } catch (error) {
    await fs.rm(dir).catch(() => undefined);
    throw error;
  }
}

type Exec = (file: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => Promise<string>;

const nodeExec: Exec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(String(stdout));
  });
});

/**
 * Reads owners and ACLs as SIDs, never as account names: names are
 * localized (`AUTORITE NT\Système`). The paths travel in an environment
 * variable, not in the script text, so no quoting can be broken; `|` cannot
 * appear in a Windows path, so it separates them.
 */
const INSPECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$sidType = [System.Security.Principal.SecurityIdentifier]',
  '$items = @()',
  "foreach ($p in $env:ROOKS_SPEECH_GUARD_PATHS.Split([char]'|')) {",
  '  $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue',
  '  if (-not $item) { $items += [pscustomobject]@{ exists = $false }; continue }',
  '  $acl = Get-Acl -LiteralPath $p',
  '  $entries = @()',
  '  foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {',
  "    $entries += [pscustomobject]@{ sid = $rule.IdentityReference.Value; allow = ($rule.AccessControlType -eq 'Allow'); inherited = $rule.IsInherited }",
  '  }',
  '  $items += [pscustomobject]@{',
  '    exists = $true',
  '    directory = [bool]$item.PSIsContainer',
  '    reparse = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)',
  '    owner = $acl.GetOwner($sidType).Value',
  '    protected = [bool]$acl.AreAccessRulesProtected',
  '    entries = $entries',
  '  }',
  '}',
  '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  'ConvertTo-Json -InputObject ([pscustomobject]@{ user = $user; items = $items }) -Depth 5 -Compress',
].join('\n');

/** Windows PowerShell 5.1 may serialize an array as `{ value: [...], Count }`, or a single item bare. */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as { value?: unknown }).value)) return (value as { value: unknown[] }).value;
  if (value === null || value === undefined) return [];
  return [value];
}

const SID = /^S-1-[0-9-]+$/;

export function parseSecuritySnapshot(stdout: string, expected: number): SecuritySnapshot {
  const raw: unknown = JSON.parse(stdout.trim());
  if (!raw || typeof raw !== 'object') throw new Error('unreadable security probe');
  const { user, items } = raw as { user?: unknown; items?: unknown };
  if (typeof user !== 'string' || !SID.test(user)) throw new Error('unreadable account SID');
  const parsed = asArray(items).map((entry): PathSecurity => {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (item.exists !== true) return { exists: false };
    return {
      exists: true,
      directory: item.directory === true,
      reparse: item.reparse !== false,
      owner: typeof item.owner === 'string' && SID.test(item.owner) ? item.owner : null,
      protected: item.protected === true,
      entries: asArray(item.entries).map((rule) => {
        const r = (rule ?? {}) as Record<string, unknown>;
        // An unreadable entry counts as an inherited grant to nobody we trust: refused.
        return {
          sid: typeof r.sid === 'string' ? r.sid : '',
          allow: r.allow !== false,
          inherited: r.inherited !== false,
        };
      }),
    };
  });
  if (parsed.length !== expected) throw new Error('incomplete security probe');
  return { user, items: parsed };
}

/** The Windows probe: PowerShell reads, `icacls` restricts. */
export function windowsSecurityProbe(env: NodeJS.ProcessEnv = process.env, exec: Exec = nodeExec): SecurityProbe {
  // Absolute paths: a writable folder earlier in PATH must not stand in for these tools.
  const system32 = win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32');
  const powershell = win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const icacls = win32.join(system32, 'icacls.exe');
  return {
    async inspect(paths) {
      // Encoded: a multi-line script survives the Windows command line intact.
      const encoded = Buffer.from(INSPECT_SCRIPT, 'utf16le').toString('base64');
      const stdout = await exec(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        env: { ...env, ROOKS_SPEECH_GUARD_PATHS: paths.join('|') },
      });
      return parseSecuritySnapshot(stdout, paths.length);
    },
    async restrict(dir, userSid) {
      if (!SID.test(userSid)) throw new Error('invalid account SID');
      await exec(icacls, [dir, '/inheritance:r', '/grant:r', `*${userSid}:(OI)(CI)F`, `*${SID_SYSTEM}:(OI)(CI)F`], { env });
    },
  };
}

export type PrepareSpeechModelsOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Built on first need: a plain home never starts PowerShell. */
  probe?: SecurityProbe;
  fs?: GuardFs;
  log?: (message: string) => void;
};

/**
 * The models folder for `home`: the first candidate that can be created and,
 * for a machine-wide one, locked down to this account.
 */
export async function prepareSpeechModels(home: string, options: PrepareSpeechModelsOptions = {}): Promise<SpeechModelsCandidate> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fs = options.fs ?? nodeFs;
  const log = options.log ?? ((message: string) => console.warn(message));
  let probe = options.probe;
  return prepareSpeechModelsDir(speechModelsDirPlan(home, platform, env), async (candidate) => {
    if (!candidate.shared) {
      await fs.mkdir(candidate.dir, { recursive: true });
      return;
    }
    // Only Windows has shared candidates; no ACL model to enforce elsewhere.
    if (platform !== 'win32') throw new SharedDirRefused('shared folders are only used on Windows');
    probe ??= windowsSecurityProbe(env);
    await ensureSharedSpeechDir(candidate.shared.root, candidate.dir, probe, fs, log);
  }, log);
}
