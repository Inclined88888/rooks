// @ts-check
/**
 * Provider template: reuse a CLI dialect for compatible endpoints, or add a
 * dialect for a different CLI protocol. Read credentials inside the env
 * resolver from plugin settings or ctx.secrets, never from process.env.
 */
import { createEchoDialect } from './echo-dialect.js'

export const name = 'provider-example'

/** @param {import('@timon-ai/sdk/provider').ProviderPluginContext} ctx */
export function apply(ctx) {
  // ── 1. Compatible profile ──────────────────────────────────────────────
  // Register unconditionally: the resolver controls availability. It is also
  // called for catalogue probes; throwing hides the profile until a key is
  // saved. Checking the key here would freeze availability at plugin load.
  ctx.backends.registerProfile({
    id: 'ollama-cloud-example',
    dialect: 'codex',
    label: 'Ollama Cloud (example)',
    vendor: 'Ollama Cloud',
    brand: 'ollama',
    custom: true,
    // Resolve on every mission launch, including short-lived token refresh.
    // The daemon never relays the error message; keep credentials out of it.
    env: () => {
      const apiKey = String(ctx.settings.get('apiKey') ?? '')
      if (!apiKey) throw new Error('apiKey setting is empty')
      return { OLLAMA_API_KEY: apiKey }
    },
    providerConfig: {
      id: 'ollama-cloud-example',
      name: 'Ollama Cloud (example)',
      baseUrl: 'https://ollama.com/v1',
      envKey: 'OLLAMA_API_KEY',
      wireApi: 'responses',
    },
    defaultModel: 'gpt-oss:120b',
    models: [
      { slug: 'gpt-oss:120b', label: 'gpt-oss:120b', contextWindow: 128_000 },
      { slug: 'gpt-oss:20b', label: 'gpt-oss:20b', contextWindow: 32_000 },
    ],
  })

  // ── 2. Custom dialect ──────────────────────────────────────────────────
  // The operator must allow the plugin-selected binary. A refusal leaves
  // the compatible profile above available.
  try {
    ctx.backends.registerDialect('echo', createEchoDialect(ctx.provider.runtime))
    ctx.backends.registerProfile({
      id: 'echo-llm',
      dialect: 'echo',
      label: 'Echo (demo)',
      vendor: 'Example',
      custom: true,
      env: () => ({ ECHO_API_KEY: String(ctx.settings.get('apiKey') ?? 'demo') }),
      defaultModel: 'echo-1',
      models: [{ slug: 'echo-1', label: 'echo-1', contextWindow: 8_000 }],
    })
  } catch (error) {
    ctx.log.warn(
      `dialect \`echo\` not registered (${error instanceof Error ? error.message : error}) — add \`echo\` to `
      + '`pluginPolicy.exec.allow` in timon.config.json to try it',
    )
  }
}
