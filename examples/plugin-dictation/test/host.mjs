// @ts-check
/**
 * The host half mounted in memory, and a `ctx.api` that reaches it: what the
 * browser half talks to, without a daemon. Routes are matched the way the
 * daemon's router does for this plugin (`:id` parameters, a JSON body parsed
 * only when the request says it is JSON). No network, no port.
 */
import { apply } from '../lib/index.js'

/**
 * @param {{ user?: () => ({ id: string } | null) }} [options]
 *   `user` is who the daemon says is calling; `null` is an anonymous request.
 */
export function mountHost(options = {}) {
  const user = options.user ?? (() => ({ id: 'alice' }))
  /** @type {Array<[string, RegExp, string[], Function]>} */
  const routes = []
  /** @type {Function[]} */
  const guards = []
  /** @type {Array<() => void>} */
  const effects = []
  const add = (/** @type {string} */ method) => (/** @type {string} */ path, /** @type {Function} */ handler) => {
    /** @type {string[]} */
    const names = []
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, name) => { names.push(name); return '([^/]+)' })}$`)
    routes.push([method, pattern, names, handler])
  }
  const router = {
    use: (/** @type {Function} */ guard) => { guards.push(guard) },
    get: add('GET'), post: add('POST'), delete: add('DELETE'),
  }
  // A stand-in for the three members the host half uses, not a whole context.
  const ctx = /** @type {import('@timon-ai/sdk').PluginContext} */ (/** @type {unknown} */ ({
    user, router: () => router, effect: (/** @type {() => () => void} */ setup) => { effects.push(setup()) },
  }))
  apply(ctx)

  /**
   * @param {string} path relative to the plugin's namespace, as `ctx.api` takes it
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  async function api(path, init = {}) {
    const method = (init.method ?? 'GET').toUpperCase()
    const url = `/${path}`
    for (const [verb, pattern, names, handler] of routes) {
      const match = verb === method ? pattern.exec(url) : null
      if (!match) continue
      const json = new Headers(init.headers).get('content-type')?.includes('application/json')
      const request = {
        params: Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1] ?? '')])),
        body: json && typeof init.body === 'string' ? JSON.parse(init.body) : {},
      }
      return new Promise((resolve) => {
        let status = 200
        const response = {
          status(/** @type {number} */ code) { status = code; return response },
          json(/** @type {unknown} */ body) {
            resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
            return response
          },
          end() { resolve(new Response(null, { status })); return response },
        }
        const run = (/** @type {number} */ i) => (i < guards.length ? guards[i](request, response, () => run(i + 1)) : handler(request, response))
        run(0)
      })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }

  return { api, dispose: () => { for (const dispose of effects.splice(0)) dispose() } }
}
