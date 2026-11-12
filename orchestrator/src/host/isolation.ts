/**
 * Filesystem isolation of a mission (audit finding #4).
 *
 * WHAT THE FINDING SAYS
 * ---------------------
 * `confine()` caps memory and CPU, nothing else. Agents run as child processes
 * of the daemon, under the SAME OS account, so `~/.ssh`, `~/.claude`,
 * `~/.codex` or another home's state are readable from any agent as soon as it
 * runs a shell command. The `cwd` is a working directory, never a jail.
 *
 * WHAT SYSTEMD CAN AND CANNOT DO HERE — measured, not assumed
 * ----------------------------------------------------------
 * Missions are launched through `systemd-run --user --scope`. A **scope** does
 * not have systemd execute the payload: `systemd-run` registers the cgroup and
 * then `exec()`s the command itself. That is precisely why `proc.pid` stays the
 * backend CLI's pid and why every `proc.kill('SIGTERM')` of `agent.ts` works.
 * The price is that a scope carries NO `Exec*` sandboxing directive:
 *
 *     $ systemd-run --user --quiet --scope --property=ProtectHome=tmpfs /bin/true
 *     Unknown assignment: ProtectHome=tmpfs        (exit 1, systemd 255)
 *
 * The same directive on a transient **service** works (`InaccessiblePaths` on
 * `~/.ssh` gives `rc=2` inside the unit), but a service means systemd owns the
 * process: stdio goes through `--pipe`, `proc.pid` becomes `systemd-run`'s, and
 * SIGTERM to that pid leaves the payload running (measured: the unit stays
 * `active`, the child survives). Moving missions to a service unit is a change
 * of process model — kill paths, reaper, stdio — not a hardening flag.
 *
 * Emitting the directives on the scope anyway would be the `-p=K=V` incident of
 * `resources.ts` all over again: `probeWrapper()` would find the wrapper
 * unusable and EVERY mission would then launch with no MemoryMax, no nice and
 * no ionice. Removing the resource guard to add a sandbox that systemd refuses
 * is a net loss. So the rule is hard:
 *
 *   **No masking directive is ever emitted on a `--scope` launcher.**
 *
 * WHAT THIS MODULE THEREFORE IS
 * -----------------------------
 * The policy — which paths a mission has no business reading — resolved as pure
 * data, with the guards that make it safe, and its rendering as systemd
 * properties. It is wired into `confine()` behind the launcher kind, so the day
 * missions run in a unit that accepts sandboxing (a service unit, a dedicated
 * OS account, a namespace: `Host.isolation.runAs`), the policy is already
 * written, tested and configurable. Until then the scope path is byte-for-byte
 * what it was, and `docs/SECURITY.md` §9.1 says so out loud.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RooksConfig } from '../config/schema.js';
import { PROTECTED_HOME_DIRS } from '../backends/credential-home-dirs.js';
import { BACKEND_HOME_DIRS } from '../backends/builtin-declarations.js';

// The two tables live in a leaf the published SDK can reach; isolation re-exports them for its callers.
export { PROTECTED_HOME_DIRS, otherBackendHomeDirProblem, protectedHomeDirProblem } from '../backends/credential-home-dirs.js';
export { BACKEND_HOME_DIRS } from '../backends/builtin-declarations.js';

/**
 * Unit kind a mission command is wrapped in. Only a unit whose process systemd
 * itself executes can carry `Exec*` sandboxing directives — see the header.
 */
export type LauncherKind = 'scope' | 'service';

export function sandboxSupported(kind: LauncherKind): boolean {
  return kind === 'service';
}

/** Why a scope cannot carry the masking, in one line, for logs and docs. */
export const SCOPE_SANDBOX_REASON =
  'a systemd --scope executes the payload itself and rejects Exec* sandboxing directives '
  + '(“Unknown assignment”), which would break the launch of every mission';

/**
 * The credential folders PROVIDERS declared (C2, `backends/provider-declarations.ts`),
 * by backend: the registry installs the source, this module asks. They join the
 * built-in table in both directions — another backend's folder is masked, the
 * mission's own is spared — which is what closes the gap the table had for the
 * providers it never named (`PROVIDERS-SDK.md` § 12.8). No source = none declared.
 */
let declaredDirsSource: () => Readonly<Record<string, readonly string[]>> = () => ({});

export function setDeclaredCredentialDirsSource(fn: () => Readonly<Record<string, readonly string[]>>): void {
  declaredDirsSource = fn;
}

/**
 * Paths masked by default, relative to the home directory. Two families:
 * OS-wide credentials an agent never needs (`.ssh`, `.gnupg`, cloud tokens),
 * and the state directories of the OTHER LLM backends — a `codex` mission has
 * no reason to read the `claude` subscription. The ancestor's home is masked
 * too (`docs/DUAL-HOME.md`); Rooks must not read it.
 */
export const DEFAULT_DENY_HOME_DIRS: readonly string[] = Object.freeze([
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gcloud',
  '.pkos', // public-name-ok: the archive's home is masked by name
  ...Object.values(BACKEND_HOME_DIRS).flat(),
]);

export type IsolationTarget = {
  /** Working directory of the mission. Never masked, ancestors included. */
  cwd?: string | undefined;
  /** Backend the mission actually runs on; its credential dir is spared. */
  backend?: string | undefined;
  /** Rooks's own home. Never masked: missions read and write their state there. */
  rooksHome?: string | undefined;
  /** Overridable for tests; defaults to the daemon user's home. */
  home?: string | undefined;
};

export type IsolationPolicy = {
  /** Absolute paths made invisible (`InaccessiblePaths`). */
  deny: readonly string[];
  /** Absolute paths kept visible but not writable (`ReadOnlyPaths`). */
  readOnly: readonly string[];
  /** `false` when `host.isolation.filesystem` is `off`. */
  enabled: boolean;
};

const EMPTY: IsolationPolicy = { deny: [], readOnly: [], enabled: false };

function expand(path: string, home: string): string {
  const raw = path.startsWith('~/') ? join(home, path.slice(2)) : path;
  return resolve(raw);
}

/** `parent` is `child` or contains it. Pure path arithmetic: no `realpath`,
 *  which would touch (and on a guarded home, read) the filesystem. */
function contains(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * The policy for one mission launch. Pure: same inputs, same output, no
 * process state read beyond the defaults it is given.
 *
 * Three guards, and they are the point of the function — a deny list that
 * swallows one of these turns a hardening measure into an outage:
 *  1. never mask the mission's `cwd`, nor any ancestor of it (a worktree under
 *     a masked home folder is exactly that case);
 *  2. never mask the credential directory of the backend actually in use;
 *  3. never mask `ROOKS_HOME` nor any ancestor of it.
 * `host.isolation.allow` is applied last and wins over everything.
 */
export function resolveIsolation(config: RooksConfig, target: IsolationTarget = {}): IsolationPolicy {
  const iso = config.host.isolation;
  if (iso.filesystem === 'off') return EMPTY;

  const home = target.home ?? homedir();
  const spared: string[] = [];
  if (target.cwd) spared.push(resolve(target.cwd));
  if (target.rooksHome) spared.push(resolve(target.rooksHome));
  const declared = declaredDirsSource();
  const ownBuiltIn = BACKEND_HOME_DIRS[target.backend ?? ''] ?? [];
  for (const dir of ownBuiltIn) spared.push(expand(`~/${dir}`, home));
  for (const path of iso.allow) spared.push(expand(path, home));

  // What a plugin declared for the running backend is spared only as that exact
  // folder, and never when it touches something the user's own credentials live
  // in: registration already refuses those (`protectedHomeDirProblem`), this is
  // the second lock for a declaration that got through another way.
  const neverSpared = [...DEFAULT_DENY_HOME_DIRS, ...PROTECTED_HOME_DIRS]
    .filter((d) => !ownBuiltIn.includes(d))
    .map((d) => expand(`~/${d}`, home));
  const sparedDeclared = (declared[target.backend ?? ''] ?? [])
    .map((dir) => expand(`~/${dir}`, home))
    .filter((path) => !neverSpared.some((n) => contains(n, path) || contains(path, n)));

  const candidates = [
    ...DEFAULT_DENY_HOME_DIRS.map((d) => expand(`~/${d}`, home)),
    ...Object.values(declared).flat().map((d) => expand(`~/${d}`, home)),
    ...iso.deny.map((p) => expand(p, home)),
  ];

  const deny: string[] = [];
  for (const path of candidates) {
    // A candidate that is a spared path, or that CONTAINS one, is dropped:
    // masking a home folder would take the worktree living under it with it.
    if (spared.some((s) => contains(path, s) || contains(s, path))) continue;
    if (sparedDeclared.includes(path)) continue;
    if (!deny.includes(path)) deny.push(path);
  }

  const readOnly: string[] = [];
  for (const path of iso.readOnly.map((p) => expand(p, home))) {
    if (deny.includes(path) || readOnly.includes(path)) continue;
    readOnly.push(path);
  }

  return { deny, readOnly, enabled: true };
}

/** systemd takes a space-separated path list; a path holding a space must be
 *  quoted or the rest of it becomes a second path. */
function pathList(paths: readonly string[]): string {
  return paths.map((p) => (/[\s"']/.test(p) ? `"${p.replace(/(["\\])/g, '\\$1')}"` : p)).join(' ');
}

/**
 * The masking directives, in the long `--property=K=V` form — the short
 * `-p=K=V` is rejected by systemd-run and breaks the spawn (see
 * `resources.test.ts`). Empty when the policy masks nothing.
 */
export function isolationProperties(policy: IsolationPolicy): string[] {
  if (!policy.enabled) return [];
  const out: string[] = [];
  if (policy.deny.length > 0) out.push(`--property=InaccessiblePaths=${pathList(policy.deny)}`);
  if (policy.readOnly.length > 0) out.push(`--property=ReadOnlyPaths=${pathList(policy.readOnly)}`);
  return out;
}

/**
 * Directives for a given launcher: the policy on a unit that accepts it, and
 * strictly nothing on a scope. Single decision point, so a future migration of
 * the mission launcher lights the whole path up by changing one argument.
 */
export function isolationArgsFor(
  kind: LauncherKind,
  config: RooksConfig,
  target: IsolationTarget = {},
): string[] {
  if (!sandboxSupported(kind)) return [];
  return isolationProperties(resolveIsolation(config, target));
}
