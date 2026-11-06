// @ts-check
/**
 * Cursor as a THIRD-PARTY provider: a plugin that is neither bundled nor shipped in the release, written against
 * `@timon-ai/sdk` and nothing else — no import of the daemon, no `@cursor/sdk` (billed per token, outside the rule
 * that Timon runs on CLI subscriptions). The daemon treats it as any stranger: no mission token, no vault slice and no
 * daemon environment in its process, and its program starts only once the superadmin has authorized the path the
 * daemon resolved for `cursor-agent` (or its alias `agent`).
 */
import { CURSOR } from './cursor.js'

export const name = 'provider-cursor'

/**
 * The name this machine answers to: `cursor-agent`, or `agent` when the installer left only that one. Which file `agent`
 * is, is not taken on trust: the daemon checks its identity (`binary.identity`) when the operator authorizes it and
 * before every launch.
 * @param {import('@timon-ai/sdk/provider').ProviderPluginContext} ctx
 */
async function installedName(ctx) {
  for (const name of CURSOR.binary.names) {
    if (await ctx.provider.binary.resolve(name)) return name
  }
  return CURSOR.binary.names[0]
}

/** @param {import('@timon-ai/sdk/provider').ProviderPluginContext} ctx */
export async function apply(ctx) {
  const program = await installedName(ctx)
  // The daemon launches, and the operator authorized, the first name: the one that resolved.
  const names = [program, ...CURSOR.binary.names.filter((name) => name !== program)]
  // Refused here, naming the program, until the operator authorizes it: nothing below runs without that.
  ctx.provider.registerProvider(ctx.provider.runtime.acp.defineProvider(ctx.provider, { ...CURSOR, binary: { ...CURSOR.binary, names } }))

  // The profile on that provider: what the agent editor and the LLM selector list. Models come from Cursor itself
  // (`modelProbe`), so none is written here. No `fallbackRank`: a provider of unknown calibre is never chosen automatically.
  ctx.backends.registerProfile({
    id: 'cursor',
    dialect: 'cursor',
    label: 'Cursor',
    vendor: 'Cursor',
    brand: 'cursor',
    custom: true,
    ...(program === CURSOR.binary.names[0] ? {} : { cmd: program }),
    requiredBinary: program,
    models: [],
    defaultModel: null,
  })
}
