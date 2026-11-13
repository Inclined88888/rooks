// @ts-check
/**
 * Ollama Cloud as an official provider plugin (`docs/PROVIDERS-SDK.md` § 11.1, volet 5e): a PROFILE on the
 * dialect of the Codex provider, nothing else — the CLI that talks to it is `codex`, the plugin brings the
 * endpoint, the models, the vault entry that holds the key and the folder to keep from other backends'
 * missions (`.ollama`).
 *
 * The profile sits inactive until the `codex` dialect is installed, whichever plugin loads first
 * (`ctx.provider.registerProductProfile`, reserved to a plugin shipped in the release: the key is a
 * reference to a vault entry, which a third party's profile cannot name).
 */
import { manifestBackend } from './manifest.js'

/** @type {import('@rooks/sdk/provider').BackendProfile} */
export const OLLAMA_CLOUD_PROFILE = {
  // Ollama Cloud through the codex CLI → `codex` dialect, no parsing of its own.
  //
  // The id `ollama` is RESERVED by codex for its built-in provider, which points hard-coded at the
  // local instance (http://localhost:11434/v1): redeclaring it makes loading config.toml fail. Hence
  // the id `ollama-cloud`. `wire_api` must be "responses" ("chat" is refused at startup); ollama.com
  // does expose /v1/responses, checked.
  id: 'ollama-cloud',
  dialect: 'codex',
  label: 'Ollama Cloud',
  vendor: 'Ollama Cloud',
  brand: 'ollama',
  custom: true,
  // Vault entry `OLLAMA_API_KEY`, or the variable of the same name in the
  // daemon's environment (`secrets.env`, installs that predate the vault).
  env: { OLLAMA_API_KEY: { secret: 'OLLAMA_API_KEY' } },
  envFrom: { OLLAMA_API_KEY: 'OLLAMA_API_KEY' },
  providerConfig: {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    envKey: 'OLLAMA_API_KEY',
    wireApi: 'responses',
  },
  // An aggregator's offer keeps moving: the list comes from upstream at runtime, not from the repo.
  // The listing is PUBLIC (no key), hence no `authFrom` — the catalogue is up to date even before a
  // key is set. See `model-discovery.ts`.
  modelsEndpoint: { url: 'https://ollama.com/v1/models', format: 'openai' },
  // What follows is only the FALLBACK (network down, endpoint failing) and the carrier of Rooks's own
  // metadata: `presetLabel` / `presetRank`, which do not exist upstream, are grafted by slug onto what
  // it returns. Two presets only, on purpose: the mission start grid must stay readable, and the rest of
  // the list is reachable from the LLM dialog, which shows the whole catalogue.
  defaultModel: 'gpt-oss:120b',
  models: [
    { slug: 'gpt-oss:120b', label: 'gpt-oss:120b', contextWindow: 128_000, presetLabel: 'gpt-oss 120b', presetRank: 100 },
    { slug: 'gpt-oss:20b', label: 'gpt-oss:20b', contextWindow: 32_000 },
    { slug: 'kimi-k3', label: 'kimi-k3', contextWindow: 128_000, presetLabel: 'Kimi K3', presetRank: 90 },
    { slug: 'kimi-k2.7-code', label: 'kimi-k2.7-code', contextWindow: 128_000 },
    { slug: 'kimi-k2.6', label: 'kimi-k2.6', contextWindow: 128_000 },
    { slug: 'glm-5.2', label: 'glm-5.2', contextWindow: 128_000 },
    { slug: 'glm-5.1', label: 'glm-5.1', contextWindow: 128_000 },
    { slug: 'deepseek-v4-pro', label: 'deepseek-v4-pro', contextWindow: 128_000 },
    { slug: 'deepseek-v4-flash', label: 'deepseek-v4-flash', contextWindow: 128_000 },
    { slug: 'qwen3.5:397b', label: 'qwen3.5:397b', contextWindow: 128_000 },
    { slug: 'minimax-m3', label: 'minimax-m3', contextWindow: 128_000 },
    { slug: 'minimax-m2.7', label: 'minimax-m2.7', contextWindow: 128_000 },
    { slug: 'mistral-large-3:675b', label: 'mistral-large-3:675b', contextWindow: 128_000 },
    { slug: 'nemotron-3-ultra', label: 'nemotron-3-ultra', contextWindow: 128_000 },
    { slug: 'nemotron-3-super', label: 'nemotron-3-super', contextWindow: 128_000 },
    { slug: 'nemotron-3-nano:30b', label: 'nemotron-3-nano:30b', contextWindow: 128_000 },
    { slug: 'gemma4:31b', label: 'gemma4:31b', contextWindow: 128_000 },
  ],
  // The folder the CLI's sign-in lives in when it is asked to use Ollama (`ollama signin`): masked from every
  // other backend's missions, kept for this one. The profile's own, not the dialect's: it runs on `codex`, whose
  // folder (`.codex`) it must not spare. Written once, in the manifest's `rooks.provider.backends`.
  credentialDirs: manifestBackend('ollama-cloud').credentialDirs,
}

export const name = 'provider-ollama-cloud'

/** @param {import('@rooks/sdk/provider').ProviderPluginContext} ctx */
export function apply(ctx) {
  ctx.provider.registerProductProfile(OLLAMA_CLOUD_PROFILE)
}
