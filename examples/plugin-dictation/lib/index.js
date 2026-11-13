/**
 * Host half: the routes the `example-daemon` engine sends its audio to,
 * through `ctx.api` in the browser half. Blocks of audio in, final text out:
 * no stream, no partial (the engine declares `interim: 'final-only'`).
 *
 * The routes need a signed-in caller, take nothing from the browser but the
 * language and the audio, keep each account's dictations to itself, and bound
 * everything they hold. They never log the audio or the text.
 */
import { randomUUID } from 'node:crypto'
import { createRecognizer } from './recognizer.js'

export const name = 'example-dictation'

const SAMPLE_RATE = 16_000
/** A block is at most 2 s of 16-bit audio (the browser half sends about 1 s). */
const BLOCK_MAX_BYTES = 2 * SAMPLE_RATE * 2
const BLOCK_MAX_BASE64 = Math.ceil(BLOCK_MAX_BYTES / 3) * 4
/** A dictation is at most 2 minutes of audio. */
const SESSION_MAX_SAMPLES = 120 * SAMPLE_RATE
const SESSIONS_PER_ACCOUNT = 2
/** A dictation nobody fed for a minute is forgotten (a closed tab never says stop). */
const SESSION_IDLE_MS = 60_000
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const LANGUAGE_RE = /^[a-z]{2,3}$/

/** Little-endian 16-bit PCM to Float32 in [-1, 1]. */
function decodeBlock(bytes) {
  const out = new Float32Array(bytes.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = bytes.readInt16LE(i * 2) / 32768
  return out
}

/** @param {import('@rooks/sdk').PluginContext} ctx */
export function apply(ctx) {
  /** id → { owner, recognizer, samples, touched } */
  const sessions = new Map()
  const router = ctx.router()

  // Required even on an installation without accounts: the voice is personal.
  router.use((_request, response, next) => {
    if (!ctx.user()) return response.status(401).json({ error: 'Authentication required' })
    next()
  })

  const sweep = (now) => {
    for (const [id, session] of sessions) if (now - session.touched > SESSION_IDLE_MS) sessions.delete(id)
  }
  /** The caller's own dictation, or null: another account's id answers 404, like an unknown one. */
  const own = (request) => {
    const session = sessions.get(String(request.params.id))
    return session && session.owner === ctx.user()?.id ? session : null
  }

  router.get('/status', (_request, response) => {
    response.json({ ready: true })
  })

  router.post('/sessions', (request, response) => {
    const now = Date.now()
    sweep(now)
    const language = request.body?.language ?? null
    if (language !== null && (typeof language !== 'string' || !LANGUAGE_RE.test(language))) {
      return response.status(400).json({ error: 'invalid language' })
    }
    const owner = ctx.user()?.id
    if (!owner) return response.status(401).json({ error: 'sign in' })
    const open = [...sessions.values()].filter((session) => session.owner === owner).length
    if (open >= SESSIONS_PER_ACCOUNT) return response.status(429).json({ error: 'too many dictations at once' })
    const id = randomUUID()
    sessions.set(id, { owner, recognizer: createRecognizer({ language }), samples: 0, touched: now })
    response.status(201).json({ id })
  })

  router.post('/sessions/:id/audio', (request, response) => {
    const session = own(request)
    if (!session) return response.status(404).json({ error: 'no such dictation' })
    const pcm = request.body?.pcm
    // Length before decoding: an oversized block costs nothing to refuse.
    if (typeof pcm !== 'string' || pcm.length > BLOCK_MAX_BASE64 || !BASE64_RE.test(pcm)) {
      return response.status(400).json({ error: 'invalid audio block' })
    }
    const bytes = Buffer.from(pcm, 'base64')
    // base64 rounds up to 3 bytes: the decoded size is the bound that holds.
    if (bytes.length % 2 !== 0 || bytes.length > BLOCK_MAX_BYTES) return response.status(400).json({ error: 'invalid audio block' })
    const samples = bytes.length / 2
    if (session.samples + samples > SESSION_MAX_SAMPLES) {
      sessions.delete(String(request.params.id))
      return response.status(413).json({ error: 'dictation too long' })
    }
    session.recognizer.accept(decodeBlock(bytes))
    session.samples += samples
    session.touched = Date.now()
    response.status(204).end()
  })

  router.post('/sessions/:id/stop', (request, response) => {
    const session = own(request)
    if (!session) return response.status(404).json({ error: 'no such dictation' })
    sessions.delete(String(request.params.id))
    response.json({ text: session.recognizer.finish() })
  })

  router.delete('/sessions/:id', (request, response) => {
    if (own(request)) sessions.delete(String(request.params.id))
    response.status(204).end()
  })

  ctx.effect(() => () => sessions.clear())
}
