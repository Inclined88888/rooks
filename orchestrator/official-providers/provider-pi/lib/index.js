// @ts-check
/**
 * Pi over its own RPC mode as an official provider plugin, written against `ctx.provider` and
 * nothing else (`docs/PROVIDERS-SDK.md` § 11.1, § 12.1). It holds the product's `pi` id: the provider
 * and its profile. Pi used to run through the `pi-acp` adapter (`provider-acp`), which dropped
 * Rooks's tools, the permission cards, the confinement of one-shots and the reasoning.
 */
import { createPiProvider } from './pi.js'
import { PI_PROFILE } from './profile.js'

export const name = 'provider-pi'

/** @param {import('@rooks/sdk/provider').ProviderPluginContext} ctx */
export function apply(ctx) {
  ctx.provider.registerProvider(createPiProvider(ctx.provider, ctx.log))
  ctx.provider.registerProductProfile(PI_PROFILE)
}
