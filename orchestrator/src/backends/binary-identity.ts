/**
 * Is the program a name resolved to the one the provider means? (`declares.binary.identity`)
 *
 * A bare name is not an identity: Cursor's installer and grok's both put an `agent` in `~/.local/bin`, and
 * the last one installed wins the name — even after the operator authorized that path for the other. A
 * provider that declares how its program describes itself (`agent --version` → `2026.10.16-…`) has it
 * checked before a mission starts it, and a mission on the wrong program fails at once, saying what the
 * program printed, instead of running a stranger's CLI with the mission's prompt.
 *
 * The answer is kept per file (path, size, modification time), so a mission start costs one run of the
 * program only after it was installed or replaced.
 *
 * The pattern comes from a manifest and is tested before the plugin's code is loaded, on up to 128 KB the
 * program printed, in the daemon's thread: V8's backtracking engine has no timeout of its own, so a pattern
 * like `^(a+)+$` would freeze every mission. It runs in a `vm` script whose timeout interrupts the match.
 * The linear engine of trigger filters (`triggers/safe-regex.ts`) was not used: it has no `m` flag and
 * refuses lookarounds and backreferences, which the SDK contract allows.
 */
import { statSync } from 'node:fs';
import { Script } from 'node:vm';
import { declaredBinary } from '../host/declared-binaries.js';
import { execTree } from '../host/kill-tree.js';
import { resolveExecutable } from '../plugins/policy.js';
import { systemEnv } from '../secrets/env.js';
import { redactText } from '../secrets/redact.js';
import type { ProviderBinaryIdentity } from './provider-declarations.js';
import { profileDeclarations } from './registry.js';

const IDENTITY_TIMEOUT_MS = 5_000;
const IDENTITY_MAX_OUTPUT = 64 * 1024;
/** A version line takes microseconds; past this, the pattern is backtracking out of control. */
const PATTERN_TIMEOUT_MS = 250;
const PRINTED_MAX_CHARS = 120;
const CACHE_MAX = 64;
export const DEFAULT_IDENTITY_ARGS: readonly string[] = ['--version'];

/** `slow`: the pattern ran past its time limit, so the program's answer could not be read at all. */
export type BinaryIdentityResult = { readonly ok: true } | { readonly ok: false; readonly printed: string; readonly slow?: true };

/** Limits of one check; tests shorten them. */
export type BinaryIdentityLimits = { readonly runTimeoutMs: number; readonly patternTimeoutMs: number };
const LIMITS: BinaryIdentityLimits = { runTimeoutMs: IDENTITY_TIMEOUT_MS, patternTimeoutMs: PATTERN_TIMEOUT_MS };

const cache = new Map<string, BinaryIdentityResult>();
const MATCH = new Script('new RegExp(pattern, "m").test(subject)');

/** `true`/`false`, or `null` when the match ran past `timeoutMs` (V8 interrupts it, the daemon goes on). */
export function testIdentityPattern(pattern: string, subject: string, timeoutMs: number = PATTERN_TIMEOUT_MS): boolean | null {
  try {
    return MATCH.runInNewContext({ pattern, subject }, { timeout: timeoutMs }) === true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return null;
    throw error;
  }
}

export class BinaryIdentityError extends Error {
  readonly code = 'binary_identity';
  constructor(message: string) {
    super(message);
    this.name = 'BinaryIdentityError';
  }
}

/** The first line the program printed, short and with secrets masked: what the refusal quotes. */
function firstLine(output: string): string {
  const line = output.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const clipped = line.length > PRINTED_MAX_CHARS ? `${line.slice(0, PRINTED_MAX_CHARS)}…` : line;
  return redactText(clipped);
}

/** Runs `program` (an absolute path) with the identity's arguments and tests what it printed. */
export async function checkBinaryIdentity(
  program: string, identity: ProviderBinaryIdentity, limits: BinaryIdentityLimits = LIMITS,
): Promise<BinaryIdentityResult> {
  const args = [...(identity.args ?? DEFAULT_IDENTITY_ARGS)];
  let stamp = '';
  try {
    const st = statSync(program);
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch { /* not a file we can stat: never cached */ }
  const key = stamp ? `${program}\0${stamp}\0${args.join('\0')}\0${identity.pattern}` : '';
  const known = key ? cache.get(key) : undefined;
  if (known) return known;
  // `execTree`: a program that leaves a child on its stdout would otherwise cost the whole limit at
  // every mission start, and leave that child running after each check.
  const run = await execTree(program, args, {
    timeout: limits.runTimeoutMs, maxBuffer: IDENTITY_MAX_OUTPUT, env: systemEnv(),
  });
  const output = `${run.stdout}\n${run.stderr}`;
  const matched = testIdentityPattern(identity.pattern, output, limits.patternTimeoutMs);
  // Not cached: under a heavy load a sane pattern could run past the limit once.
  if (matched === null) return { ok: false, printed: firstLine(output), slow: true };
  const result: BinaryIdentityResult = matched ? { ok: true } : { ok: false, printed: firstLine(output) };
  // A program stopped by the timeout said nothing about itself: on a loaded machine, the next try must really ask.
  if (key && !run.timedOut) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
  }
  return result;
}

/**
 * The refusal a person reads: which file, what it said, what was expected, what to do. `who`: "backend `cursor`".
 * `where`: the field the pattern came from, the one the provider must change.
 */
export function binaryIdentityRefusal(
  who: string, program: string, identity: ProviderBinaryIdentity, printed: string, slow = false, where = 'declares.binary.identity',
): string {
  const args = (identity.args ?? DEFAULT_IDENTITY_ARGS).join(' ');
  if (slow) {
    return `\`${program}\` could not be checked as the program ${who} runs: its \`${where}.pattern\` `
      + `ran past ${PATTERN_TIMEOUT_MS} ms on what \`${args}\` printed. The provider must declare a simpler pattern.`;
  }
  const expected = identity.expected ? ` (${identity.expected})` : '';
  const said = printed ? `printed "${printed}"` : 'printed nothing';
  return `\`${program}\` is not the program ${who} runs${expected}: \`${args}\` ${said}. `
    + 'Install the right program, or pin its path in `host.binaries` (timon.config.json).';
}

/**
 * Before a mission starts `cmd` for `backend`: throws `BinaryIdentityError` when the provider declared an
 * identity and the program does not have it. A backend that declared none passes untouched.
 */
export async function assertLaunchIdentity(backend: string, cmd: string): Promise<void> {
  const identity = profileDeclarations(backend)?.binary?.identity;
  if (!identity) return;
  const program = resolveExecutable(cmd) ?? cmd;
  const result = await checkBinaryIdentity(program, identity);
  if (!result.ok) throw new BinaryIdentityError(binaryIdentityRefusal(`backend \`${backend}\``, program, identity, result.printed, result.slow));
}

/**
 * Before a provider plugin runs its declared program `name` (resolved to `program`) through
 * `ctx.provider.binary` — a version, a probe, the model probe's conversation, a server: the same check as a
 * mission's launch, from the declaration that names it. Throws `BinaryIdentityError`.
 */
export async function assertDeclaredIdentity(name: string, program: string, who: string): Promise<void> {
  const identity = declaredBinary(name)?.identity;
  if (!identity) return;
  const result = await checkBinaryIdentity(program, identity);
  if (!result.ok) throw new BinaryIdentityError(binaryIdentityRefusal(who, program, identity, result.printed, result.slow));
}

/** Tests only: forget what was learned. */
export function resetBinaryIdentityCache(): void {
  cache.clear();
}
