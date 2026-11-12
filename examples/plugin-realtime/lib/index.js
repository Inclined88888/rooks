export const name = 'example-realtime'

/** @param {import('@rooks/sdk').PluginContext} ctx */
export function apply(ctx) {
  // Demo state is per account and resets when the plugin is unloaded.
  const counts = new Map()
  const router = ctx.router()
  // Require an identified caller even on an installation without accounts.
  router.use((_request, response, next) => {
    if (!ctx.user()) return response.status(401).json({ error: 'Authentication required' })
    next()
  })
  router.get('/count', (_request, response) => {
    response.json({ count: counts.get(ctx.user()?.id) ?? 0 })
  })
  router.post('/increment', (_request, response) => {
    const ownerUserId = ctx.user()?.id
    if (!ownerUserId) return response.status(401).json({ error: 'Authentication required' })
    const count = (counts.get(ownerUserId) ?? 0) + 1
    counts.set(ownerUserId, count)
    ctx.realtime.publish('changed', { count }, { ownerUserId })
    response.json({ count })
  })
  ctx.effect(() => () => counts.clear())
}
