import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from './lib/index.js'

test('routes reject anonymous callers and publish only for the current account', () => {
  const handlers = new Map()
  const signals = []
  const effects = []
  let caller
  let guard
  const router = {
    use(fn) { guard = fn },
    get(path, fn) { handlers.set(`GET ${path}`, fn) },
    post(path, fn) { handlers.set(`POST ${path}`, fn) },
  }
  apply({
    user: () => caller,
    router: () => router,
    realtime: { publish: (...args) => signals.push(args) },
    effect: (setup) => effects.push(setup()),
  })
  const request = (route) => {
    const result = { status: 200, body: undefined }
    const response = {
      status(code) { result.status = code; return response },
      json(body) { result.body = body; return response },
    }
    guard({}, response, () => handlers.get(route)({}, response))
    return result
  }
  assert.equal(request('GET /count').status, 401)
  assert.equal(request('POST /increment').status, 401)
  assert.deepEqual(signals, [])
  caller = { id: 'alice' }
  assert.deepEqual(request('POST /increment').body, { count: 1 })
  assert.deepEqual(signals, [['changed', { count: 1 }, { ownerUserId: 'alice' }]])
  caller = { id: 'bob', is_superadmin: true }
  assert.deepEqual(request('GET /count').body, { count: 0 })
  caller = { id: 'alice' }
  assert.deepEqual(request('GET /count').body, { count: 1 })
  effects.forEach((dispose) => dispose())
  assert.deepEqual(request('GET /count').body, { count: 0 })
})
