/**
 * The program a mission launch is about to start, judged against the plugin
 * policy (`docs/SECURITY.md` § 6.4.1, `docs/PROVIDERS-SDK.md` § 12 question 4).
 *
 * `ctx.host.exec` and `registerProvider` already refuse the subscription CLIs to a
 * plugin (`plugins/policy.ts`), but the process a MISSION runs is started by the daemon from whatever
 * the dialect's `buildSpawn` returned — a plugin's code chooses it at launch, not
 * only at registration. So the launch is held to the same lists:
 *
 *   - `core`: the product's own dialects, unchanged;
 *   - `official` (a provider shipped in the release): a subscription CLI only when
 *     the provider declared that program (`declares.binary`, which the manifest's
 *     `provider.binaries` authorized) — the exemption is for the program it names
 *     and nothing broader. A generic launcher, `timon`, a git credential helper:
 *     never, for anyone;
 *   - `third-party`: none of those, whatever its manifest declares.
 *
 * The operator's allowlist (`pluginPolicy.exec.allow`) is asked by
 * `assertLaunchAuthorized`, below, for a third-party backend only. The name-based
 * limits of `plugins/policy.ts` apply here: a renamed copy of `claude` is not caught.
 */
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { config } from '../config/load.js';
import {
  binKey, canonicalExecutable, canonicalPath, execDeniedReason, isSubscriptionCli, PluginPolicyError, resolveExecutable, samePath,
} from '../plugins/policy.js';
import { backendTrust, dialectDeclarations, isOfficialDialect, profileDeclarations, registeredBackendOwners, activeProfiles } from './registry.js';
import { baseBackendId } from './instance-id.js';
import { clearLaunchCard, raiseLaunchCard } from './launch-card.js';
import { launchProvenance } from './launch-provenance.js';

/** The plugin that answers for backend `backend`'s code, for the refusal. */
function ownerOf(backend: string): string {
  const dialect = activeProfiles().find((entry) => entry.profile.id === backend)?.profile.dialect;
  return (dialect ? registeredBackendOwners().dialects[dialect] : undefined)
    ?? registeredBackendOwners().profiles[baseBackendId(backend)] ?? 'unknown';
}


export function assertLaunchBinary(backend: string, cmd: string): void {
  const trust = backendTrust(backend);
  if (trust === 'core') return;
  const declared = (profileDeclarations(backend)?.binary?.names ?? []).map(binKey);
  const owner = ownerOf(backend);
  // The program as named, and what the name resolves to: an alias that points at `claude` is still `claude`.
  const resolved = resolveExecutable(cmd);
  for (const target of resolved && resolved !== cmd ? [cmd, resolved] : [cmd]) {
    const denied = execDeniedReason(target);
    if (!denied) continue;
    const key = binKey(target);
    if (trust === 'official' && isSubscriptionCli(key) && declared.includes(key)) continue;
    throw new PluginPolicyError(owner, 'host:exec', `backend \`${backend}\` launches \`${key}\`: ${denied}`
      + (trust === 'official' ? ' (an official provider may launch the subscription CLI it declares, nothing else)' : ''));
  }
}

/**
 * The files a third-party backend's launch may start, links followed, read LIVE at every launch — a
 * first spawn, a resume, a per-turn respawn — so a withdrawn authorization holds from the next one:
 *  - an absolute entry of `pluginPolicy.exec.allow` names THAT file. An authorization writes the file a
 *    link leads to (`exec-grants.ts`); an entry that is itself a link names no program, and a link
 *    retargeted after the authorization leads to another file: both need the operator to authorize again;
 *  - a bare-name entry keeps its meaning, "what the host resolves this name to", and is compared as the
 *    file it resolves to now: `/elsewhere/opencode` is not `opencode` because its basename is;
 *  - a third party's profile that sets no command of its own on an OFFICIAL dialect runs that dialect's
 *    program: the files its declared names resolve to (the code that chose it is the release's).
 */
function authorizedPrograms(backend: string): string[] {
  const programs: string[] = [];
  for (const entry of config().pluginPolicy.exec.allow) {
    if (isAbsolute(entry)) programs.push(entry);
    else {
      const file = canonicalExecutable(entry);
      if (file) programs.push(file);
    }
  }
  const resolved = activeProfiles().find((entry) => entry.profile.id === backend);
  if (resolved && !resolved.profile.cmd && isOfficialDialect(resolved.profile.dialect, resolved.dialect)) {
    const dialect = resolved.dialect;
    const names = [
      ...('defaultCmd' in dialect && typeof dialect.defaultCmd === 'string' ? [dialect.defaultCmd] : []),
      ...(dialectDeclarations(resolved.profile.dialect)?.binary?.names ?? []),
    ];
    for (const name of names) {
      const file = canonicalExecutable(name);
      if (file) programs.push(file);
    }
  }
  return programs;
}

/**
 * What a third-party launch checked, pinned to the file itself: the path the spawn starts, the file it
 * led to (links followed) and that file's identity on disk (device and inode; the file index on NTFS).
 * The check and the spawn are not one system call: the provider's identity check runs in between
 * (`binary-identity.ts`, it starts the program), so a link retargeted or a file renamed over the checked
 * one during that time would be started unchecked. `assertLaunchPinned` is the last thing before the
 * spawn. No content hash (decision 3-B, option C set aside): a file rewritten in place keeps its inode.
 */
export type LaunchPin = {
  readonly backend: string;
  readonly owner: string;
  /** The path the spawn starts (`SpawnResult.cmd`). */
  readonly program: string;
  /** The file it led to when checked. */
  readonly file: string;
  readonly dev: bigint;
  readonly ino: bigint;
};

function fileIdentity(file: string): { dev: bigint; ino: bigint } | null {
  try {
    const st = statSync(file, { bigint: true });
    return st.isFile() ? { dev: st.dev, ino: st.ino } : null;
  } catch {
    return null;
  }
}

/** A refused third-party launch: the error the mission reports, and the card that leads to the fix. */
function refuse(owner: string, backend: string, message: string): PluginPolicyError {
  const error = new PluginPolicyError(owner, 'host:exec', message);
  raiseLaunchCard(owner, backend, `${message.charAt(0).toUpperCase()}${message.slice(1).replace(/\.?$/, '.')}`);
  return error;
}

/**
 * Before a THIRD-PARTY backend's launch starts `cmd` (TODO #531, decision 3-B): the file it really
 * launches — resolved on this host, links followed — must be one the operator authorized
 * (`authorizedPrograms`) or, for a program the daemon installed itself, exactly that program
 * (`launch-provenance.ts`, typed, never a pattern on a folder). What is compared is the final path, not
 * a basename. Returns the resolved path the spawn must use, so a search path that moves between this
 * check and the spawn cannot land on another file, and the pin `assertLaunchPinned` holds the spawn to.
 * A product backend (core or official) passes untouched: its exemptions are `assertLaunchBinary`'s.
 * A refusal raises an `action_required` card (`launch-card.ts`, TODO #598).
 */
export function assertLaunchAuthorized(backend: string, cmd: string): { program: string; pin: LaunchPin | null } {
  if (backendTrust(backend) !== 'third-party') return { program: cmd, pin: null };
  const owner = ownerOf(backend);
  const resolved = resolveExecutable(cmd);
  if (!resolved) {
    throw refuse(owner, backend, `backend \`${backend}\` launches \`${cmd}\`, which is no program on this host: nothing to compare with what was authorized`);
  }
  const launched = canonicalPath(resolved);
  // The name was judged by `assertLaunchBinary`; the file a link leads to is judged here.
  const denied = execDeniedReason(launched);
  if (denied) throw refuse(owner, backend, `backend \`${backend}\` launches \`${launched}\`: ${denied}`);
  const provenance = launchProvenance(baseBackendId(backend));
  if (provenance) {
    if (!samePath(canonicalPath(provenance.path), launched)) {
      throw refuse(owner, backend, `backend \`${backend}\` launches \`${launched}\`, not the program the daemon installed for it `
        + `(${provenance.source} ${provenance.version}: \`${provenance.path}\`)`);
    }
  } else if (!authorizedPrograms(backend).some((program) => samePath(program, launched))) {
    throw refuse(owner, backend, `backend \`${backend}\` launches \`${launched}\`, which \`pluginPolicy.exec.allow\` does not authorize: `
      + 'the program moved, a link now leads elsewhere, or the authorization was withdrawn. '
      + 'If this is the program you expect, authorize it again from the provider\'s page (Settings › AI models › Backends).');
  }
  const identity = fileIdentity(launched);
  if (!identity) throw refuse(owner, backend, `backend \`${backend}\` launches \`${launched}\`, which is not a regular file`);
  clearLaunchCard(owner);
  return { program: resolved, pin: { backend, owner, program: resolved, file: launched, ...identity } };
}

/**
 * The spawn is about to start `pin.program`: it must still lead to the very file that was checked, by
 * path and by identity. Synchronous, and called with nothing awaited between it and the spawn. What it
 * cannot see is what happens after it — between this call and the `execve` of the launcher chain — and
 * a file rewritten in place (`docs/SECURITY.md` § 6.4.1).
 */
export function assertLaunchPinned(pin: LaunchPin): void {
  const file = canonicalPath(pin.program);
  const identity = fileIdentity(file);
  if (samePath(file, pin.file) && identity && identity.dev === pin.dev && identity.ino === pin.ino) return;
  throw refuse(pin.owner, pin.backend, `backend \`${pin.backend}\` was about to launch \`${pin.program}\`, which no longer is the file `
    + `checked for this launch (\`${pin.file}\`): it was replaced, or a link moved, between the check and the launch`);
}
