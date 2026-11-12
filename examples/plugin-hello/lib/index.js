export const name = 'plugin-hello'
export const inject = ['settings']

/** @param {import('@rooks/sdk').PluginContext} ctx */
export function apply(ctx) {
  const router = ctx.router()
  router.get('/hello', (_request, response) => {
    response.json({
      plugin: ctx.id,
      greeting: ctx.settings.get('greeting') ?? 'Bonjour depuis un plugin',
    })
  })
}
