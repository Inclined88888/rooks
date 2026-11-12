/**
 * The Rooks agents of the Hermes profiles the caller connected, in one call.
 *
 * A profile only one of the caller's connections serves gets the door agent
 * `hermes.<profile>` (model `hermes/<profile>`): a door, not a copy — each
 * account that talks to it reaches its OWN gateway. A profile several of the
 * caller's gateways serve gets one agent per connection instead,
 * `hermes.<label>.<profile>` (model `hermes/<connectionId>/<profile>`), which
 * reaches that connection and serves its owner only. An existing door agent is
 * never renamed nor re-pointed to a connection: it keeps working as before.
 */
import type { PluginAgent, PluginContext, PluginUserConnection } from '@rooks/sdk';
import { connectionProfile, modelOfConnection, modelOfProfile, parseModel, usable } from './connection.js';
import { PROFILE_ID } from './driver.js';

/** `kept`: already pointing at the right place; `skipped`: a name someone else's agent holds. */
export type SyncReport = { created: string[]; updated: string[]; kept: string[]; skipped: string[] };

/** Lowercase, never starting with `_` or `.` (unchanged: it names the agents already in place). */
function profileSlug(profile: string): string {
  return profile.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+/, '') || 'default';
}

const MAX_NAME = 100;

/** Without dots, which separate the parts of an agent's name. */
function labelSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '').slice(0, 40).replace(/[-_]+$/, '');
}

/** `hermes.<profile>`: lowercase, never starting with `_` or `.`. */
export function agentNameFor(profile: string): string {
  return `hermes.${profileSlug(profile)}`;
}

/**
 * `hermes.<label>.<profile>` for one connection; `withId` adds the start of its
 * id, for when the label alone is taken (two gateways labelled alike, or
 * another account's agent). Deterministic: a second click finds the same name.
 */
export function connectionAgentName(connection: Pick<PluginUserConnection, 'id' | 'label' | 'config'>, withId = false): string {
  const profile = profileSlug(connectionProfile(connection));
  const id = labelSlug(connection.id).slice(0, 8);
  // Agent names stop at 100 characters: the label gives way first.
  const room = MAX_NAME - 'hermes.'.length - 1 - profile.length - (withId ? id.length + 1 : 0);
  const label = labelSlug(connection.label).slice(0, Math.max(0, room)).replace(/[-_]+$/, '');
  const middle = withId || !label ? [label, id].filter(Boolean).join('-') : label;
  return `hermes.${middle}.${profile}`;
}

function promptFor(profile: string): string {
  return `You are the Hermes agent of the profile "${profile}", reached through the user's Hermes gateway. `
    + 'You work on the gateway\'s machine with your own tools; you do not see Rooks\'s files.';
}

export async function syncAgents(ctx: Pick<PluginContext, 'agents'>, connections: readonly PluginUserConnection[]): Promise<SyncReport> {
  const agents = await ctx.agents.list();
  const known = new Map(agents.map((a) => [a.name.toLowerCase(), a]));
  const report: SyncReport = { created: [], updated: [], kept: [], skipped: [] };
  const live = connections.filter(usable);
  const callerIds = new Set(connections.map((c) => c.id));
  const pinnedTo = (agent: PluginAgent) => (agent.backend === PROFILE_ID ? parseModel(agent.model)?.connectionId ?? null : null);
  // This plugin's agent pinned to a connection the caller does not hold is
  // someone else's: it is never re-pointed to the caller's gateway.
  const door = (agent: PluginAgent) => { const pinned = pinnedTo(agent); return !pinned || callerIds.has(pinned); };

  /** `mayRepoint`: whether an agent of this plugin under `name`, routed elsewhere, may be re-pointed. */
  async function place(name: string, model: string, profile: string, mayRepoint: (agent: PluginAgent) => boolean): Promise<'done' | 'taken'> {
    const fields = { systemPrompt: promptFor(profile), role: 'research', backend: PROFILE_ID, model };
    const existing = known.get(name.toLowerCase());
    if (!existing) {
      const created = await ctx.agents.create({ name, ...fields });
      known.set(name.toLowerCase(), created);
      report.created.push(name);
    } else if (existing.mine && existing.backend === fields.backend && existing.model === fields.model) {
      // Untouched: an update of the routing restarts the agent's live missions.
      report.kept.push(existing.name);
    } else if (existing.mine && mayRepoint(existing)) {
      // A person may have reworded the prompt: only the routing is refreshed.
      await ctx.agents.update(existing.name, { backend: fields.backend, model: fields.model });
      report.updated.push(existing.name);
    } else {
      return 'taken';
    }
    return 'done';
  }

  const byProfile = new Map<string, PluginUserConnection[]>();
  for (const connection of live) {
    const profile = connectionProfile(connection);
    byProfile.set(profile, [...(byProfile.get(profile) ?? []), connection]);
  }
  for (const [profile, served] of byProfile) {
    if (served.length === 1) {
      const name = agentNameFor(profile);
      if (await place(name, modelOfProfile(profile), profile, door) === 'taken') report.skipped.push(known.get(name.toLowerCase())?.name ?? name);
      continue;
    }
    for (const connection of served) {
      const model = modelOfConnection(connection);
      // Found by its routing first: a renamed agent or a relabelled connection keeps its agent.
      const already = agents.find((a) => a.mine && a.backend === PROFILE_ID && a.model === model);
      if (already) { report.kept.push(already.name); continue; }
      // Re-pointed only when pinned to this very connection (its profile changed):
      // a door agent or another gateway's agent keeps its routing.
      const same = (agent: PluginAgent) => pinnedTo(agent) === connection.id;
      if (await place(connectionAgentName(connection), model, profile, same) === 'done') continue;
      const fallback = connectionAgentName(connection, true);
      if (await place(fallback, model, profile, same) === 'taken') report.skipped.push(known.get(fallback.toLowerCase())?.name ?? fallback);
    }
  }
  return report;
}
