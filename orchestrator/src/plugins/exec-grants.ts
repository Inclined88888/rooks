/**
 * Authorizing the binary of a provider plugin (`docs/PROVIDERS-SDK.md` §12.4).
 *
 * A provider launches a program of the machine (`cursor-agent`, `opencode`…).
 * Until now the operator had to write that program into
 * `pluginPolicy.exec.allow` by hand, with no way to know which file the bare
 * name would resolve to. This module is the other way round: the manifest names
 * the binaries (`provider.binaries`), the DAEMON resolves them on the host's own
 * search path, the superadmin is shown the RESOLVED path and accepts it, and the
 * accepted path is what lands in the allowlist.
 *
 * Four rules keep this from being a door:
 *  - a path comes from the daemon's own resolution of a name the staged
 *    manifest declared, never from the client. The client sends back what it was
 *    shown, and any difference (the binary moved between the preview and the
 *    click) is a refusal, not a silent substitute;
 *  - the absolute denylist of `policy.ts` (`claude`, `codex`, `rooks`, shells,
 *    package runners…) applies to the name AND the resolved target;
 *  - the file is written by editing the operator's own `rooks.config.json`
 *    (never the merged, env-overridden `config()`), so nothing but the allowlist
 *    entry reaches the disk;
 *  - a program whose manifest says how it describes itself (`identity`) is held
 *    to that, on the click and never before: the preview runs nothing, and a
 *    stranger who goes by the same name is refused before anything is written.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { binaryIdentityRefusal, checkBinaryIdentity } from '../backends/binary-identity.js';
import { CONFIG_FILE, loadConfig, setConfig, config } from '../config/load.js';
import type { PluginManifest } from './manifest.js';
import { canonicalPath, execDeniedReason, resolveExecutable, samePath } from './policy.js';

export type ProviderBinaryRequest = {
  /** The declared name, as written in the manifest. */
  name: string;
  /** The name (or alias) that resolved, `null` when none did. */
  found: string | null;
  /**
   * The file the name launches on this host, links followed (`canonicalPath`), `null` when the program
   * is not installed. What the operator accepts and what a mission launch is compared to: a link
   * retargeted afterwards names another file, which needs a new authorization.
   */
  resolved: string | null;
  /** The resolved path is already in `pluginPolicy.exec.allow`. */
  allowed: boolean;
  /** Why this binary can never be authorized, `null` otherwise. */
  refused: string | null;
};

export class ExecGrantError extends Error {
  constructor(readonly code: 'mismatch' | 'refused' | 'not-provider' | 'binary-identity', message: string, readonly status: 400 | 409) {
    super(message);
    this.name = 'ExecGrantError';
  }
}

type Json = Record<string, unknown>;

function allowList(): readonly string[] {
  return config().pluginPolicy.exec.allow;
}

/** What the install preview and the settings page show for a provider. */
export function providerBinaryRequests(manifest: Pick<PluginManifest, 'kind' | 'provider'>): ProviderBinaryRequest[] {
  if (!manifest.kind.includes('provider')) return [];
  const allow = allowList();
  return (manifest.provider?.binaries ?? []).map((decl) => {
    const candidates = [decl.name, ...decl.aliases];
    for (const candidate of candidates) {
      const found = resolveExecutable(candidate);
      if (!found) continue;
      const resolved = canonicalPath(found);
      const refused = execDeniedReason(candidate) ?? execDeniedReason(found) ?? execDeniedReason(resolved);
      return {
        name: decl.name,
        found: candidate,
        resolved,
        allowed: !refused && allow.some((entry) => isAbsolute(entry) && samePath(entry, resolved)),
        refused,
      };
    }
    return {
      name: decl.name,
      found: null,
      resolved: null,
      allowed: false,
      refused: candidates.map((c) => execDeniedReason(c)).find((r): r is string => r !== null) ?? null,
    };
  });
}

function readUserConfig(file: string): Json {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the configuration file root must be a JSON object');
  }
  return parsed as Json;
}

function obj(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

/** Rewrites `pluginPolicy.exec.allow` in the operator's file, then refreshes the live config. */
function updateAllow(file: string, change: (current: string[]) => string[]): string[] {
  const cfg = readUserConfig(file);
  const policy = obj(cfg.pluginPolicy);
  const exec = obj(policy.exec);
  const current = Array.isArray(exec.allow) ? exec.allow.filter((e): e is string => typeof e === 'string') : [];
  const next = change(current);
  cfg.pluginPolicy = { ...policy, exec: { ...exec, allow: next } };
  // Same directory, then rename: the file watchers never read a half-written file.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  renameSync(tmp, file);
  if (file === CONFIG_FILE) setConfig(loadConfig(file));
  return next;
}

const CHANGED = 'the resolved binaries changed since they were shown — review them again';

/** The paths this host resolves now, once what can never be authorized is refused. */
function grantablePaths(manifest: Pick<PluginManifest, 'id' | 'kind' | 'provider'>): { requests: ProviderBinaryRequest[]; paths: string[] } {
  if (!manifest.kind.includes('provider')) {
    throw new ExecGrantError('not-provider', `plugin \`${manifest.id}\` is not a provider`, 400);
  }
  const requests = providerBinaryRequests(manifest);
  const refused = requests.find((r) => r.refused);
  if (refused) throw new ExecGrantError('refused', refused.refused!, 400);
  return { requests, paths: [...new Set(requests.flatMap((r) => (r.resolved ? [r.resolved] : [])))] };
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p) => b.some((q) => samePath(q, p)));
}

/**
 * Starts each accepted program that declared an identity and tests what it prints. It runs through the path a
 * mission's launch would use (the link, not its target: a launcher may read its own name), so both ask the
 * same question and share the answer `checkBinaryIdentity` keeps per file.
 */
async function assertIdentities(
  manifest: Pick<PluginManifest, 'id' | 'provider'>,
  requests: readonly ProviderBinaryRequest[],
): Promise<void> {
  // `providerBinaryRequests` maps the declarations one to one, in order.
  for (const [i, request] of requests.entries()) {
    const identity = manifest.provider?.binaries[i]?.identity;
    if (!identity || !request.found || !request.resolved) continue;
    // An earlier program took time to answer: only the file the operator accepted may start.
    const program = resolveExecutable(request.found);
    if (!program || !samePath(canonicalPath(program), request.resolved)) throw new ExecGrantError('mismatch', CHANGED, 409);
    const result = await checkBinaryIdentity(program, identity);
    if (!result.ok) {
      throw new ExecGrantError('binary-identity', binaryIdentityRefusal(`provider \`${manifest.id}\``, request.resolved, identity, result.printed, result.slow, 'provider.binaries[].identity'), 409);
    }
  }
}

/**
 * The paths the operator must have accepted for this provider: `accepted` must be
 * exactly the set of resolvable, non-refused paths the daemon computes now;
 * anything else is a 409 so the person looks again. Writes nothing, starts nothing.
 */
export function checkProviderBinaries(
  manifest: Pick<PluginManifest, 'id' | 'kind' | 'provider'>,
  accepted: readonly string[],
): string[] {
  const { paths: expected } = grantablePaths(manifest);
  if (!samePaths(expected, [...new Set(accepted)])) throw new ExecGrantError('mismatch', CHANGED, 409);
  return expected;
}

/**
 * Adds to the allowlist the paths the operator accepted for this provider
 * (`checkProviderBinaries`). Those programs are then held to their declared
 * identity; only then is anything written.
 */
export async function grantProviderBinaries(
  manifest: Pick<PluginManifest, 'id' | 'kind' | 'provider'>,
  accepted: readonly string[],
  file: string = CONFIG_FILE,
): Promise<{ granted: string[]; added: string[] }> {
  const expected = checkProviderBinaries(manifest, accepted);
  const { requests } = grantablePaths(manifest);
  if (!expected.length) return { granted: [], added: [] };
  await assertIdentities(manifest, requests);
  // What was checked is what gets written: the programs took time to answer, and a name can move meanwhile.
  if (!samePaths(grantablePaths(manifest).paths, expected)) throw new ExecGrantError('mismatch', CHANGED, 409);
  const added: string[] = [];
  updateAllow(file, (current) => {
    added.push(...expected.filter((p) => !current.some((c) => isAbsolute(c) && samePath(c, p))));
    return [...current, ...added];
  });
  return { granted: expected, added };
}

/** Removes exactly these entries (a grant rolled back after a failed install). */
export function removeAllowEntries(paths: readonly string[], file: string = CONFIG_FILE): void {
  if (!paths.length) return;
  updateAllow(file, (current) => current.filter((entry) => !(isAbsolute(entry) && paths.some((p) => samePath(p, entry)))));
}
