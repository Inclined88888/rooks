// @ts-check
/**
 * Codex CLI as an official provider plugin, written against `ctx.provider` and nothing else
 * (`docs/PROVIDERS-SDK.md` § 11.1, § 12.1). It ships in the release, is loaded the way a third
 * party's plugin is, and its files are vouched for by the signed inventory.
 *
 * The profile and dialect keep their historical ids, models and fallback ranking.
 */
import { createCodexProvider } from './codex.js'
import { CODEX_PROFILE } from './profile.js'

export const name = 'provider-codex'

/** @param {import('@rooks/sdk/provider').ProviderPluginContext} ctx */
export function apply(ctx) {
  ctx.provider.registerProvider(createCodexProvider(ctx.provider, ctx.log))
  ctx.provider.registerProductProfile(CODEX_PROFILE)
}
