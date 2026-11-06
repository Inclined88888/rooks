// @ts-check
/**
 * Grok Build, the xAI CLI, as an official provider plugin: the first of the product's
 * own providers written against `ctx.provider` and nothing else
 * (`docs/PROVIDERS-SDK.md` § 11.1, § 12.1). It ships in the release, is loaded the way a
 * third party's plugin is, and its files are vouched for by the signed inventory.
 *
 * It brings the dialect, what it declares, and the `grok` profile (`lib/profile.js`), under the id
 * every installation already names (missions, roles, cooldowns).
 */
import { createGrokProvider } from './grok.js'
import { GROK_PROFILE } from './profile.js'

export const name = 'provider-grok'

/** @param {import('@timon-ai/sdk/provider').ProviderPluginContext} ctx */
export function apply(ctx) {
  ctx.provider.registerProvider(createGrokProvider(ctx.provider, ctx.log))
  ctx.provider.registerProductProfile(GROK_PROFILE)
}
