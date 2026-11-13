// @ts-check
/**
 * Remote backend template: a dialect with no local process, and the profile
 * that offers it in the backend menus. No allowlist is needed, since nothing
 * is spawned.
 */
import { createMemoryDialect } from './memory-dialect.js'

export const name = 'remote-backend-example'

/** @param {import('@rooks/sdk/provider').ProviderPluginContext} ctx */
export function apply(ctx) {
  // The dialect is built from the daemon's own runtime (API 12): a fix to a codec
  // or to a driver reaches this plugin without a new release.
  ctx.backends.registerDialect('memory-remote', createMemoryDialect(ctx.provider.runtime))
  ctx.backends.registerProfile({
    id: 'memory-remote',
    dialect: 'memory-remote',
    label: 'Memory agent (demo)',
    vendor: 'Example',
    custom: true,
    // Resolved at every mission launch and handed to openSession as `env`.
    // A real plugin throws while its key is missing, which keeps the backend
    // out of the menus until the key is saved.
    env: () => ({ MEMORY_AGENT_API_KEY: String(ctx.settings.get('apiKey') ?? 'demo') }),
    defaultModel: 'memory-1',
    models: [{ slug: 'memory-1', label: 'memory-1', contextWindow: 8_000 }],
  })
}
