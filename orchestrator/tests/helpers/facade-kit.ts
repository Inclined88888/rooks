/**
 * Shared harness of the facade tests of API 10 (agent docs and lifecycle,
 * messages, skills, MCP servers, backend catalogue): a plugin context on the
 * real daemon host, and the callers a facade must tell apart.
 *
 * Import it FIRST in a test file: it isolates `ROOKS_HOME` and installs the
 * test licence before any module that reads them. It lives outside `src/` so
 * that the build never ships it.
 */
import '../../src/test-home.js';
import './paid-license.js';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('../../src/plugins/manifest.js');
const { createPluginContext, daemonHost } = await import('../../src/plugins/context.js');
const { mountOfficialProviders } = await import('./official-providers.js');
await mountOfficialProviders();
const { runPluginRequest } = await import('../../src/plugins/als.js');

export type Identity = Parameters<typeof runPluginRequest>[0];

export const caller = (id: string, permissions: string[], isSuperadmin = false): Identity => ({
  viewer: { id, isSuperadmin, permissions },
  user: { id, email: `${id}@example.com`, name: id, is_superadmin: isSuperadmin },
  ownerUserId: id,
});

/** An account holding exactly `permissions` (e.g. `agents:manage`). */
export const account = (id: string, permissions: string[]): Identity => caller(id, permissions);
export const admin = caller('root', [], true);
export const nobody = caller('nobody', []);
export const anonymous: Identity = { viewer: null, user: undefined, ownerUserId: null };

/** Runs `fn` as the request of `who`. Outside it, a plugin acts as a job. */
export const as = <T>(who: Identity, fn: () => Promise<T>): Promise<T> => runPluginRequest(who, fn);

export async function pluginWith(permissions: string[], id = 'acme-api10') {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ rooks: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

/** An error carrying `code`, whatever its class. */
export const code = (c: string) => (err: unknown) => (err as { code?: unknown } | null)?.code === c;
