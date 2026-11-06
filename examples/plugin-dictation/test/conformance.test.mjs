// @ts-check
/**
 * The dictation bench of `@timon-ai/sdk/testing` on both engines: the checks
 * Timon holds every engine to. No microphone, no model, no daemon — the host
 * half is mounted in memory (`./host.mjs`) and fed fake audio.
 *
 *   node --test test/
 *
 * With your own model, give the bench a recording and the words in it:
 * `speech: readWavPcm(readFileSync('test/fixtures/hello.wav'))`, `transcript: /hello/i`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  defineConformanceTests, dictationEngineChecks, fakeUtterance, runDictation, speechLikePcm,
} from '@timon-ai/sdk/testing'
import { createDaemonEngine, createPageEngine } from '../lib/client.js'
import { mountHost } from './host.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const transcript = 'Example transcript: 1.5 s of speech (fr).'

/** One block of `seconds` of audio, as the browser half encodes it. */
const block = (/** @type {number} */ seconds) => JSON.stringify({ pcm: Buffer.alloc(Math.round(seconds * 16_000) * 2).toString('base64') })
const json = { 'content-type': 'application/json' }

// ── The routes refuse first ──────────────────────────────────────────────────

test('[routes] an anonymous caller is refused everywhere', async () => {
  const { api } = mountHost({ user: () => null })
  for (const [path, method] of [['status', 'GET'], ['sessions', 'POST'], ['sessions/x/audio', 'POST'], ['sessions/x/stop', 'POST'], ['sessions/x', 'DELETE']]) {
    assert.equal((await api(path, { method, headers: json, body: '{}' })).status, 401, `${method} ${path}`)
  }
})

test('[routes] another account\'s dictation is unknown, not forbidden', async () => {
  let caller = { id: 'alice' }
  const { api } = mountHost({ user: () => caller })
  const { id } = await (await api('sessions', { method: 'POST', headers: json, body: '{}' })).json()
  caller = { id: 'bob' }
  assert.equal((await api(`sessions/${id}/audio`, { method: 'POST', headers: json, body: block(0.1) })).status, 404)
  assert.equal((await api(`sessions/${id}/stop`, { method: 'POST' })).status, 404)
  caller = { id: 'alice' }
  assert.equal((await api(`sessions/${id}/stop`, { method: 'POST' })).status, 200, 'Bob did not end it')
})

test('[routes] what the browser sends is bounded and checked', async () => {
  const { api } = mountHost()
  const open = async (body = '{}') => api('sessions', { method: 'POST', headers: json, body })
  assert.equal((await open(JSON.stringify({ language: 'fr-FR' }))).status, 400)
  assert.equal((await open(JSON.stringify({ language: 42 }))).status, 400)
  const { id } = await (await open()).json()
  const send = (/** @type {string} */ body) => api(`sessions/${id}/audio`, { method: 'POST', headers: json, body })
  assert.equal((await send(block(2.1))).status, 400, 'a block longer than 2 s')
  assert.equal((await send(JSON.stringify({ pcm: Buffer.alloc(64_002).toString('base64') }))).status, 400, 'one sample past 2 s')
  assert.equal((await send(JSON.stringify({ pcm: 'not base64!' }))).status, 400)
  assert.equal((await send(JSON.stringify({ pcm: Buffer.alloc(3).toString('base64') }))).status, 400, 'an odd byte count')
  assert.equal((await send(JSON.stringify({}))).status, 400)
  await open()
  assert.equal((await open()).status, 429, 'a third dictation at once')
  for (let i = 0; i < 60; i += 1) assert.equal((await send(block(2))).status, 204)
  assert.equal((await send(block(0.1))).status, 413, 'past 2 minutes of audio')
  assert.equal((await api(`sessions/${id}/stop`, { method: 'POST' })).status, 404, 'a dictation that went too long is dropped')
})

// ── The engines ──────────────────────────────────────────────────────────────

defineConformanceTests(test, dictationEngineChecks(createPageEngine(), { manifest, language: 'fr', transcript }), '[example-page]')

const host = mountHost()
defineConformanceTests(test, dictationEngineChecks(createDaemonEngine(host.api), { manifest, language: 'fr', transcript }), '[example-daemon]')

test('[example-daemon] a refused block ends the session with an error the user can act on', async () => {
  let caller = /** @type {{ id: string } | null} */ ({ id: 'alice' })
  const { api } = mountHost({ user: () => caller })
  const engine = createDaemonEngine(async (path, init) => {
    const response = await api(path, init)
    if (path === 'sessions') caller = null // signed out after the dictation started
    return response
  })
  const run = await runDictation(engine, speechLikePcm(2.5), { settleMs: 20 })
  assert.deepEqual(run.problems, [])
  assert.deepEqual(run.errors.map((e) => [e.code, e.fatal]), [['denied', true]])
  assert.deepEqual(run.finals, [])
  assert.equal(run.stopped, true)
})

test('[example-daemon] cancel and abort release the dictation on the daemon', async () => {
  const { api } = mountHost()
  const engine = createDaemonEngine(api)
  // Two at once is the limit: if either run left its dictation open, the next two could not start.
  await runDictation(engine, fakeUtterance(), { end: 'cancel', endAfterMs: 1200, settleMs: 20 })
  await runDictation(engine, fakeUtterance(), { end: 'abort', endAfterMs: 1200, settleMs: 20 })
  const open = () => api('sessions', { method: 'POST', headers: json, body: '{}' })
  assert.equal((await open()).status, 201)
  assert.equal((await open()).status, 201)
})
