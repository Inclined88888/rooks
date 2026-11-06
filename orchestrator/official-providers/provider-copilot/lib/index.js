// @ts-check
/**
 * GitHub Copilot CLI as an official provider plugin, written against `ctx.provider` and nothing
 * else (`docs/PROVIDERS-SDK.md` § 11.1, § 12.1). It ships in the release, is loaded the way a
 * third party's plugin is, and its files are vouched for by the signed inventory.
 *
 * It brings the dialect, what it declares, and the `copilot` profile (`lib/profile.js`: fallback
 * models, `envFrom` for `COPILOT_HOME` / `GH_HOST`), under the id every installation already names.
 */
import { createCopilotProvider } from './copilot.js'
import { COPILOT_PROFILE } from './profile.js'

export const name = 'provider-copilot'

/** @param {import('@timon-ai/sdk/provider').ProviderPluginContext} ctx */
export function apply(ctx) {
  ctx.provider.registerProvider(createCopilotProvider(ctx.provider))
  ctx.provider.registerProductProfile(COPILOT_PROFILE)
}
