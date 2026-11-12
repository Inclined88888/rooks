/**
 * One Rooks agent per profile of an external system, in one call.
 *
 * `syncAgents` is the whole recipe: create the agents that do not exist yet,
 * refresh the ones this plugin created, and leave alone an agent a person made
 * under the same name — `ctx.agents.update` would refuse it anyway.
 */

/** Agent name of a profile: lowercase slug, never starting with `_` or `.`. */
export function agentName(prefix, profileId) {
  const slug = String(profileId).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+/, '');
  return `${prefix}.${slug || 'profile'}`;
}

/**
 * @param {{ agents: import('@rooks/sdk').PluginContext['agents'] }} ctx
 * @param {{ id: string, prompt: string, look?: import('@rooks/sdk').PluginAgentLookInput }[]} profiles
 * @param {{ prefix?: string, role?: string, backend?: string, model?: string }} [defaults]
 */
export async function syncAgents(ctx, profiles, defaults = {}) {
  const prefix = defaults.prefix ?? 'sync';
  const known = new Map((await ctx.agents.list()).map((a) => [a.name.toLowerCase(), a]));
  /** @type {{ created: string[], updated: string[], skipped: string[] }} */
  const report = { created: [], updated: [], skipped: [] };
  for (const profile of profiles) {
    const name = agentName(prefix, profile.id);
    const fields = {
      systemPrompt: profile.prompt,
      role: defaults.role ?? 'research',
      ...(defaults.backend ? { backend: defaults.backend } : {}),
      ...(defaults.model ? { model: defaults.model } : {}),
      // The mascot drawn for the agent; a value off the daemon's lists is `invalid`.
      ...(profile.look ? { look: profile.look } : {}),
    };
    const existing = known.get(name.toLowerCase());
    if (!existing) {
      await ctx.agents.create({ name, ...fields });
      report.created.push(name);
    } else if (existing.mine) {
      await ctx.agents.update(existing.name, fields);
      report.updated.push(existing.name);
    } else {
      report.skipped.push(existing.name);
    }
  }
  return report;
}

const STATUS = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409 };

/** @param {import('@rooks/sdk').PluginContext} ctx */
export function apply(ctx) {
  const router = ctx.router();

  // The agents this plugin made, for its own screen.
  router.get('/agents', (_req, res, next) => {
    ctx.agents.list().then((agents) => res.json({ agents: agents.filter((a) => a.mine) })).catch(next);
  });

  // `{ profiles: [{ id, prompt, look? }], backend?, model? }` — runs as the caller:
  // an account without `agents:manage` is refused, whatever this plugin holds.
  router.post('/sync', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const profiles = Array.isArray(body.profiles) ? body.profiles : [];
    syncAgents(ctx, profiles, { backend: body.backend, model: body.model })
      .then((report) => res.json(report))
      .catch((err) => res.status(STATUS[err.code] ?? 403).json({ error: err.message, code: err.code ?? null }));
  });
}
