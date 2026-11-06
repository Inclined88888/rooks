/**
 * Fixture : le plugin nominal. Il fait le minimum qui prouve quelque chose —
 * une route (dont on vérifie qu'elle disparaît au `disable`) et un effet (dont
 * on vérifie qu'il est défait au déchargement).
 *
 * La trace passe par `globalThis` et non par un export : le loader importe ce
 * fichier avec un `?rev=` qui casse le cache ESM, donc le test et le loader ne
 * partagent PAS la même instance de module.
 */
export const name = 'fixture-ok'
export const inject = ['storage']

const trace = (globalThis.__timonFixtureTrace ??= [])

export function apply(ctx, config) {
  trace.push(`apply:${ctx.id}:${config.marker ?? ''}`)
  ctx.router().get('/ping', (_req, res) => res.json({ ok: true, id: ctx.id }))
  ctx.effect(() => {
    trace.push('effect')
    return () => trace.push('dispose')
  })
}
