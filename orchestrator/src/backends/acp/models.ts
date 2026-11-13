/**
 * The models an ACP agent says it can run, asked of the agent itself.
 *
 * Which models opencode or Hermes offer depends on the account and on what the
 * user configured (opencode reaches every provider it holds a key for; Hermes
 * listed 83 on the tested install), so a list written in the product is right
 * for nobody. `session/new` returns it — opencode as a `model` config option,
 * Hermes as `models.availableModels` (`modelIdsFromSessionNew` reads both).
 *
 * Same bargain as the Copilot provider's probe, and the same wart:
 * opening a session leaves an EMPTY one in the agent's own history, in the
 * user's `opencode` / `hermes` session list. No prompt is sent, so nothing is
 * spent, but the history is visible — hence a long cache, and a probe that
 * starts in ROOKS's home rather than in a project the user would find it in.
 * The process is bounded in time and always stopped.
 *
 * The thinking levels are per model (opencode offers an `effort` option only
 * for a model that has variants, and its values differ from one to the next),
 * so after the list the probe selects each model of the throwaway session and
 * reads the options that come back. Best effort: an agent that cannot do that
 * (Hermes) or runs out of the time given to it yields models with no level,
 * never a failed probe.
 *
 * The process is the daemon's, opened for the provider (`ctx.provider.binary.converse`):
 * the program is one the manifest declared, its environment is the system whitelist
 * plus the profile's own, never the daemon's (the probe runs a third-party program,
 * and the daemon's environment holds the secrets of every connector), and it starts
 * in the daemon's home, not in a project the user would find the empty session in.
 *
 * A leaf, handed to providers as `runtime.acp.discoverModels`: it reaches no
 * process of its own, so a provider cannot use it to start a program the operator
 * did not authorize.
 */

import { AcpRpcError, AcpTransportError, type AcpRecord, type AcpTransport } from './transport.js';
import { acpTransportOver, type AcpConversation } from './conversation-transport.js';
import { RPC_AUTH_REQUIRED, currentModel, newSessionAuthenticating, thoughtLevels } from './driver.js';
import type { DiscoveredModel } from '../types.js';
import { signInAdvice, type AcpSignIn } from './auth.js';
import { modelIdsFromSessionNew } from '../model-ids.js';

/** Whole probe, start to kill. A cold Python agent (Hermes) is slow to import. */
const PROBE_TIMEOUT_MS = 30_000;
/** Each request; the whole probe stays under `PROBE_TIMEOUT_MS`. */
const REQUEST_TIMEOUT_MS = 25_000;
/** What the levels pass may take once the list is in hand: the list is worth
 *  more than the levels, so they never use up the probe's own deadline. */
const LEVELS_BUDGET_MS = 10_000;

/**
 * A successful answer is reused this long. Every probe leaves an empty session
 * in the user's history, and the catalogue asks again every 30 minutes and at
 * each boot: at 12 hours a machine that stays up adds two a day, not forty-eight.
 */
const ANSWER_TTL_MS = 12 * 60 * 60 * 1000;

/** Most ids handed to the catalogue. One agent listed 83; a menu that long is
 *  not one anybody chooses from, and an agent that lists thousands must not
 *  fill the catalogue. Ids the profile itself names are never cut. */
export const MAX_DISCOVERED_MODELS = 60;
const MAX_ID_CHARS = 200;

/** JSON-RPC "method not found". */
const RPC_METHOD_NOT_FOUND = -32601;

const answers = new Map<string, { models: DiscoveredModel[]; at: number }>();
const inflight = new Map<string, Promise<DiscoveredModel[]>>();

export type AcpProbeOptions = {
  /**
   * Opens the agent in ACP mode, through the daemon: `() => ctx.provider.binary.converse(name, args, { env })`.
   * Rejects when the program is not declared or not installed.
   */
  open(): Promise<AcpConversation>;
  /** The program, as the user knows it: the messages name it, and with `profileId` it is the cache key. */
  command: string;
  /** Profile id, the cache key. */
  profileId: string;
  /** The agent's sign-in advice, when its provider declared one. */
  signIn?: AcpSignIn;
  /** The auth method to try once on `auth_required` (`AcpAgentSpec.authenticateWith`). */
  authenticateWith?: string;
  /** Ids the answer must keep when it is cut (the profile's own models, plus
   *  the agent's current one). */
  keep?: readonly string[];
  now?: number;
  timeoutMs?: number;
  levelsBudgetMs?: number;
};

/** Ids usable as a model slug: non-empty, bounded, no control characters. */
function usable(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_CHARS
    // eslint-disable-next-line no-control-regex
    && !/[\u0000-\u001f\u007f]/.test(id);
}

/**
 * Deduplicated, sorted, and bounded to `max`. Sorted with a plain code-point
 * comparison: the list must not reorder itself with the machine's locale. When
 * the agent lists more than `max`, ids in `keep` survive first, the rest fill
 * up in that same order.
 */
export function selectModels(ids: readonly unknown[], keep: readonly string[] = [], max = MAX_DISCOVERED_MODELS): string[] {
  const all = [...new Set(ids.filter(usable))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (all.length <= max) return all;
  const kept = new Set(keep.filter((id) => all.includes(id)).slice(0, max));
  const chosen = new Set(kept);
  for (const id of all) {
    if (chosen.size >= max) break;
    chosen.add(id);
  }
  return all.filter((id) => chosen.has(id));
}

/**
 * Models of the agent, with the thinking levels each declares, from the cache
 * when it is fresh. Rejects — with a
 * message a human can act on — when the binary is missing, the agent wants a
 * sign-in, refuses the session, or answers nothing in time. The catalogue then
 * keeps the profile's own list.
 */
export function discoverAcpModels(opts: AcpProbeOptions): Promise<DiscoveredModel[]> {
  const key = `${opts.profileId}\0${opts.command}`;
  const now = opts.now ?? Date.now();
  const cached = answers.get(key);
  if (cached && now - cached.at < ANSWER_TTL_MS) return Promise.resolve(cached.models);
  const running = inflight.get(key);
  if (running) return running;
  const started = probe(opts).then((models) => {
    answers.set(key, { models, at: now });
    return models;
  }).finally(() => { inflight.delete(key); });
  inflight.set(key, started);
  return started;
}

/** Forgets what was learned. For tests and for a user who just signed in. */
export function forgetAcpModels(): void {
  answers.clear();
}

/** What the user is told, whatever the transport said — never the agent's own
 *  text, which carries request ids and sometimes an account. */
function failure(opts: AcpProbeOptions, err: unknown, init: { authMethods?: unknown } | null): Error {
  const who = `\`${opts.command}\``;
  if (err instanceof AcpRpcError && err.code === RPC_AUTH_REQUIRED) {
    const advice = signInAdvice(opts.signIn, init?.authMethods);
    return new Error(`${who} needs you to sign in first${advice ? ` — ${advice}` : ''}`);
  }
  if (err instanceof AcpRpcError) return new Error(`${who} refused the session (code ${err.code})`);
  if (err instanceof AcpTransportError) {
    switch (err.kind) {
      case 'spawn': return new Error(`${who} could not be started: is it installed and on the PATH?`);
      case 'timeout': return new Error(`${who} did not answer in time`);
      case 'exited': return new Error(`${who} stopped before it listed its models`);
      default: return new Error(`${who} did not speak the Agent Client Protocol`);
    }
  }
  return err instanceof Error && err.message.startsWith(who) ? err : new Error(`${who} could not list its models`);
}

/**
 * The levels of each model, by selecting it in the session. `levels` is filled
 * as the pass goes, so what was learned before a failure or the end of the
 * budget is kept. Skipped when the agent has no `model` config option to select
 * through (the Hermes shape): `session/set_model` answers nothing to read.
 */
async function collectLevels(
  transport: AcpTransport, sessionId: string, created: AcpRecord, slugs: readonly string[], levels: Map<string, string[]>,
  budgetMs: number,
): Promise<void> {
  const selectable = Array.isArray(created.configOptions)
    && created.configOptions.some((o) => o !== null && typeof o === 'object' && (o as AcpRecord).id === 'model');
  if (!selectable) return;
  const current = currentModel(created);
  const stopAt = Date.now() + budgetMs;
  for (const slug of slugs) {
    if (slug === current) continue;
    const left = stopAt - Date.now();
    if (left <= 0) return;
    // An agent that never answers this request must not hold the pass past its budget.
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), left); });
    const request = transport.setConfigOption(sessionId, 'model', slug);
    request.catch(() => undefined);
    try {
      const reply = await Promise.race([request, late]);
      if (reply === 'late') return;
      const found = thoughtLevels(reply);
      if (found) levels.set(slug, found.levels);
    } catch (err) {
      // This model is refused: the next may not be. Anything else (agent gone,
      // no such method) ends the pass.
      if (!(err instanceof AcpRpcError) || err.code === RPC_METHOD_NOT_FOUND) return;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function probe(opts: AcpProbeOptions): Promise<DiscoveredModel[]> {
  let channel: ReturnType<typeof acpTransportOver>;
  try {
    channel = acpTransportOver(await opts.open(), { requestTimeoutMs: REQUEST_TIMEOUT_MS });
  } catch {
    throw failure(opts, new AcpTransportError('spawn', 'spawn'), null);
  }
  const { transport } = channel;
  const seen: { init: { authMethods?: unknown } | null; slugs: string[] | null } = { init: null, slugs: null };
  const levels = new Map<string, string[]>();
  const listed = (slugs: readonly string[]): DiscoveredModel[] => slugs.map((slug) => {
    const own = levels.get(slug);
    return own ? { slug, supportedReasoningLevels: own } : { slug };
  });
  let deadline: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new AcpTransportError('timeout', 'probe')), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  });
  timedOut.catch(() => undefined);
  try {
    const run = (async (): Promise<DiscoveredModel[]> => {
      seen.init = await transport.initialize();
      const created = await newSessionAuthenticating(transport, seen.init, { cwd: channel.cwd, mcpServers: [] }, opts.authenticateWith);
      const ids = modelIdsFromSessionNew(created.result);
      if (ids.length === 0) throw new Error(`\`${opts.command}\` returned no model`);
      const current = currentModel(created.result);
      const slugs = selectModels(ids, [...(opts.keep ?? []), ...(current ? [current] : [])]);
      seen.slugs = slugs;
      const own = current ? thoughtLevels(created.result) : null;
      if (current && own) levels.set(current, own.levels);
      await collectLevels(transport, created.sessionId, created.result, slugs, levels, opts.levelsBudgetMs ?? LEVELS_BUDGET_MS);
      return listed(slugs);
    })();
    // A losing `run` must not surface as an unhandled rejection.
    run.catch(() => undefined);
    return await Promise.race([run, timedOut]);
  } catch (err) {
    // The list is in hand: a levels pass that died or hung costs the levels, not the models.
    if (seen.slugs) return listed(seen.slugs);
    throw failure(opts, err, seen.init);
  } finally {
    clearTimeout(deadline);
    await channel.stop();
  }
}
