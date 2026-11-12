/**
 * Hermes Gateway — host half.
 *
 * Makes the Hermes agents of a user's own Hermes gateway answer in Rooks like
 * any other agent (chat, missions, tasks other than `code`). Written only with
 * the public plugin SDK: a remote backend (`ctx.backends`), per-user
 * connections (`ctx.connections`), `ctx.fetch` towards the approved gateway,
 * and `ctx.agents` for the "create the agents" button.
 */
import type { PluginContext, PluginUserConnection } from '@rooks/sdk';
import { syncAgents } from './agents.js';
import {
  connectionProfile, connectionType, pickConnection, qualifiedType, resolveTarget, SECRET_KEY, usable,
} from './connection.js';
import { createHermesDialect, DIALECT_ID, PROFILE_ID } from './driver.js';
import { checkGateway, targetUrls, type Fetch } from './gateway.js';

export const name = 'hermes-gateway';

export { createHermesDialect } from './driver.js';
export { syncAgents, agentNameFor, connectionAgentName } from './agents.js';
export { connectionType, resolveTarget, parseModel } from './connection.js';

type ConnectionStatus = {
  id: string;
  label: string;
  profile: string;
  origin: string;
  approval: PluginUserConnection['approval'];
  enabled: boolean;
  state: 'ok' | 'pending' | 'off' | 'error';
  version: string | null;
  message: string | null;
  /** The Rooks agents a mission of the caller reaches this gateway through. */
  agents: string[];
};

const AGENT_ERROR_STATUS: Record<string, number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409 };

export function apply(ctx: PluginContext): void {
  const typeId = qualifiedType(ctx.id);
  // Present whenever `http:outbound` is declared, which the manifest does.
  const outbound = ctx.fetch;
  if (!outbound) throw new Error('hermes-gateway needs the http:outbound permission');
  const fetch: Fetch = (input, init) => outbound(input, init);

  // Synchronous, before any await: the daemon reattaches the missions of the
  // previous run right after loading plugins, and a dialect registered later
  // would find them already declared lost.
  ctx.backends.registerDialect(DIALECT_ID, createHermesDialect({
    fetch,
    resolveTarget: (launch, model) => resolveTarget(ctx.connections, typeId, launch, model),
    log: { info: (m) => ctx.log.info(m), warn: (m) => ctx.log.warn(m) },
  }));
  ctx.backends.registerProfile({
    id: PROFILE_ID,
    dialect: DIALECT_ID,
    label: 'Hermes Gateway',
    vendor: 'Nous Research',
    custom: true,
    // The gateway and its key belong to the account that launches the
    // mission and depend on the agent's profile: the driver resolves them in
    // start(), where a missing connection is told to that user only. Visibility
    // is global, so nothing here may depend on a user.
    env: () => ({}),
    defaultModel: 'hermes/default',
    models: [{ slug: 'hermes/default', label: 'Hermes — default profile' }],
    slugPrefixes: ['hermes/'],
    subscription: { note: 'Runs on your own Hermes gateway: its models, its tools, its key (Settings › Secrets › Connections).' },
  });
  ctx.connections.registerType(connectionType());

  const router = ctx.router();

  // The caller's gateways and what each answers right now.
  router.get('/status', (_req, res, next) => {
    const user = ctx.user();
    if (!user) { res.status(401).json({ error: 'sign in' }); return; }
    (async () => {
      const mine = (await ctx.connections.forUser(user.id)).filter((c) => c.type === typeId);
      const served = await agentsByConnection(mine);
      const connections = await Promise.all(mine.map(async (c) => ({ ...await statusOf(c, user.id), agents: served.get(c.id) ?? [] })));
      res.json({ connections });
    })().catch(next);
  });

  // One agent per connected profile, created or re-pointed, as the caller.
  router.post('/agents', (_req, res) => {
    const user = ctx.user();
    if (!user) { res.status(401).json({ error: 'sign in' }); return; }
    (async () => {
      const mine = (await ctx.connections.forUser(user.id)).filter((c) => c.type === typeId);
      if (!mine.some(usable)) {
        res.status(409).json({ error: 'Add an approved Hermes gateway connection first.', code: 'no_connection' });
        return;
      }
      res.json(await syncAgents(ctx, mine));
    })().catch((err: unknown) => {
      const code = err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : null;
      const message = err instanceof Error ? err.message : 'agents could not be created';
      res.status(code ? AGENT_ERROR_STATUS[code] ?? 403 : 403).json({ error: message, code });
    });
  });

  /**
   * Which agent reaches which of the caller's gateways, by the very rule a
   * mission follows. An account that may not read agents sees no names.
   */
  async function agentsByConnection(mine: readonly PluginUserConnection[]): Promise<Map<string, string[]>> {
    const served = new Map<string, string[]>();
    let agents: Awaited<ReturnType<typeof ctx.agents.list>>;
    try { agents = await ctx.agents.list(); } catch { return served; }
    for (const agent of agents) {
      if (agent.backend !== PROFILE_ID) continue;
      let target: PluginUserConnection;
      try { target = pickConnection(mine, agent.model); } catch { continue; }
      served.set(target.id, [...(served.get(target.id) ?? []), agent.name]);
    }
    return served;
  }

  async function statusOf(connection: PluginUserConnection, owner: string): Promise<Omit<ConnectionStatus, 'agents'>> {
    const profile = connectionProfile(connection);
    const base = {
      id: connection.id, label: connection.label, profile, origin: new URL(connection.url).origin,
      approval: connection.approval, enabled: connection.enabled, version: null, message: null,
    };
    if (connection.approval === 'rejected') return { ...base, state: 'error', message: 'An administrator refused this address.' };
    if (connection.approval !== 'approved') return { ...base, state: 'pending' };
    if (!connection.enabled) return { ...base, state: 'off' };
    const key = await ctx.connections.userSecret(owner, connection.id, SECRET_KEY);
    if (!key) return { ...base, state: 'error', message: 'No API key is set for this connection.' };
    const { root, base: profileBase } = targetUrls(connection.url, profile);
    const check = await checkGateway(fetch, { root, base: profileBase, profile, key, sessionKey: null }, AbortSignal.timeout(10_000));
    return check.ok
      ? { ...base, state: 'ok', version: check.version }
      : { ...base, state: 'error', message: check.message };
  }
}
