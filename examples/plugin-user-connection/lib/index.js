/**
 * Host half. Declares a connection type, then, for the account calling its
 * route, reads THAT account's connection and key and calls the service.
 * The only Timon dependency is the public PluginContext.
 */

/** @param {unknown} value */
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return /** @type {Record<string, unknown>} */ (value);
}
/** Same contract as a Zod schema: `parse` returns the clean value or throws. */
const configSchema = {
  /**
   * @param {unknown} value
   * @returns {import('@timon-ai/sdk').PluginJsonObject}
   */
  parse(value) {
    const { workspace, ...rest } = object(value);
    if (Object.keys(rest).length) throw new Error('Unknown field');
    if (workspace === undefined || workspace === '') return {};
    if (typeof workspace !== 'string' || workspace.length > 64) throw new Error('Invalid workspace');
    return { workspace };
  },
};

/** @param {string} base @param {string} path */
const endpoint = (base, path) => new URL(path, base.endsWith('/') ? base : `${base}/`).href;

/** @param {import('@timon-ai/sdk').PluginContext} ctx */
export function apply(ctx) {
  const type = `${ctx.id}:service@1`;

  ctx.connections.registerType({
    name: 'service', version: 1,
    label: 'Example service',
    description: 'An HTTP service reached with a bearer key.',
    configSchema,
    fields: [{ key: 'workspace', label: 'Workspace', placeholder: 'default' }],
    secrets: [{ name: 'apiKey', label: 'API key', required: true }],
    // The settings "Test" button. `context.fetch` stays on this connection's
    // origin and goes through the daemon's SSRF guard.
    async test(context) {
      const key = await context.secret('apiKey');
      const response = await context.fetch(endpoint(context.connection.url, 'health'), {
        headers: { authorization: `Bearer ${key}` }, signal: context.signal,
      });
      return { ok: response.ok, message: response.ok ? 'Service reachable' : `Service answered ${response.status}` };
    },
  });

  // GET /api/plugins/user-connection-example/status — for the CALLER only.
  const router = ctx.router();
  router.get('/status', async (_req, res) => {
    const user = ctx.user();
    if (!user) { res.status(401).json({ error: 'sign in' }); return; }
    const connections = await ctx.connections.forUser(user.id);
    const usable = connections.find((c) => c.type === type && c.enabled && c.approval === 'approved');
    if (!usable) { res.json({ connected: false, pending: connections.some((c) => c.approval === 'pending') }); return; }
    const key = await ctx.connections.userSecret(user.id, usable.id, 'apiKey');
    // Present only with `http:outbound` in the manifest.
    if (!ctx.fetch) { res.status(500).json({ error: 'http:outbound is not granted' }); return; }
    try {
      // Reachable because an approved connection opened this origin.
      const response = await ctx.fetch(endpoint(usable.url, 'health'), { headers: { authorization: `Bearer ${key}` } });
      res.json({ connected: true, status: response.status });
    } catch (error) {
      // A refusal names the rule, never the key.
      res.status(502).json({ connected: true, error: error instanceof Error ? error.message : 'unreachable' });
    }
  });
}
