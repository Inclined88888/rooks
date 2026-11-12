/**
 * Browser half: two speech-to-text engines in the `dictation.engine` slot.
 *
 *  - `example-page` runs here, in the window. Nothing leaves it (`egress: none`).
 *    Put your WASM or WebGPU model where it says "your model".
 *  - `example-daemon` sends blocks of about one second of audio to this
 *    plugin's own routes (`lib/index.js`) through `ctx.api`, and gets the final
 *    text when the user stops (`egress: daemon`, `interim: final-only`).
 *
 * The product opens the microphone, picks the language, keeps the session and
 * the draft: an engine only receives 16 kHz mono samples between `start()` and
 * `stop()` / `cancel()`, and only reports events. Its text is plain text.
 */

const SAMPLE_RATE = 16_000
const VOICED_RMS = 0.01

function rms(pcm) {
  let sum = 0
  for (const sample of pcm) sum += sample * sample
  return pcm.length ? Math.sqrt(sum / pcm.length) : 0
}

/** The stand-in transcript: how much voiced audio was heard, never text on silence. */
function exampleTranscript(voicedMs, language) {
  if (!voicedMs) return ''
  return `Example transcript: ${(voicedMs / 1000).toFixed(1)} s of speech${language ? ` (${language})` : ''}.`
}

/** @returns {import('@rooks/sdk').DictationEngine} */
export function createPageEngine() {
  return {
    id: 'example-page',
    label: 'Example engine (in this window)',
    languages: { codes: ['en', 'fr'], mode: 'forced' },
    interim: 'live',
    async availability() {
      // A real engine answers `needs-setup` until its model is downloaded, with a reason the user can act on.
      return { state: 'ready' }
    },
    async start({ language, signal, onEvent }) {
      let voicedMs = 0
      let ended = false
      const end = () => {
        ended = true
        signal.removeEventListener('abort', onAbort)
        onEvent({ type: 'stopped' })
      }
      const onAbort = () => { if (!ended) end() }
      signal.addEventListener('abort', onAbort)
      return {
        feed(pcm) {
          if (ended) return
          // Your model: hand it the samples, report what it has so far.
          if (rms(pcm) > VOICED_RMS) {
            voicedMs += (pcm.length / SAMPLE_RATE) * 1000
            onEvent({ type: 'partial', text: exampleTranscript(voicedMs, language) })
          }
        },
        async stop() {
          if (ended) return
          const text = exampleTranscript(voicedMs, language)
          if (text) onEvent({ type: 'final', text })
          end()
        },
        cancel() {
          if (!ended) end()
        },
      }
    },
  }
}

/** Float32 samples to little-endian 16-bit PCM, base64 (a JSON body, the daemon's parser reads it). */
function encodeBlock(chunks, samples) {
  const bytes = new Uint8Array(samples * 2)
  const view = new DataView(bytes.buffer)
  let at = 0
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const s = Math.max(-1, Math.min(1, sample))
      view.setInt16(at, s < 0 ? s * 32768 : s * 32767, true)
      at += 2
    }
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

class RouteError extends Error {
  constructor(status) {
    super(`The dictation service answered ${status}.`)
    this.status = status
  }
}

/** What the user is told when a block or the final text cannot be had. */
/** @returns {import('@rooks/sdk').DictationEvent} */
function errorEvent(error) {
  const status = error instanceof RouteError ? error.status : 0
  if (status === 401 || status === 403) return { type: 'error', code: 'denied', message: 'Sign in again to dictate.', fatal: true }
  if (status === 429) return { type: 'error', code: 'busy', message: 'Too many dictations at once.', fatal: true }
  if (!status) return { type: 'error', code: 'network', message: 'The daemon cannot be reached.', fatal: true }
  return { type: 'error', code: 'crashed', message: error.message, fatal: true }
}

/**
 * @param {(path: string, init?: RequestInit) => Promise<Response>} api the plugin's `ctx.api`
 * @returns {import('@rooks/sdk').DictationEngine}
 */
export function createDaemonEngine(api) {
  const call = async (path, init) => {
    const response = await api(path, init)
    if (!response.ok) throw new RouteError(response.status)
    return response
  }
  const post = (body, signal) => ({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  })
  return {
    id: 'example-daemon',
    label: 'Example engine (on the daemon)',
    languages: { codes: ['en', 'fr'], mode: 'forced' },
    interim: 'final-only',
    async availability() {
      try {
        const response = await api('status')
        return response.ok ? { state: 'ready' } : { state: 'unavailable', reason: `The daemon answered ${response.status}.` }
      } catch {
        return { state: 'unavailable', reason: 'The daemon cannot be reached.' }
      }
    },
    async start({ language, signal, onEvent }) {
      const { id } = await (await call('sessions', post({ language }, signal))).json()
      const route = `sessions/${encodeURIComponent(id)}`
      let ended = false
      let chunks = []
      let samples = 0
      // Blocks leave one after the other, in order; a failed one stops the rest.
      let queue = Promise.resolve()

      const end = () => {
        ended = true
        signal.removeEventListener('abort', onAbort)
        onEvent({ type: 'stopped' })
      }
      const release = () => { api(route, { method: 'DELETE' }).catch(() => {}) }
      const fail = (error) => {
        if (ended) return
        onEvent(errorEvent(error))
        release()
        end()
      }
      const onAbort = () => {
        if (ended) return
        release()
        end()
      }
      signal.addEventListener('abort', onAbort)
      const flush = () => {
        if (!samples) return
        const pcm = encodeBlock(chunks, samples)
        chunks = []
        samples = 0
        queue = queue
          .then(() => (ended ? undefined : call(`${route}/audio`, post({ pcm }, signal))))
          .then(() => undefined, fail)
      }

      return {
        feed(pcm) {
          if (ended) return
          chunks.push(pcm)
          samples += pcm.length
          if (samples >= SAMPLE_RATE) flush()
        },
        async stop() {
          if (ended) return
          flush()
          await queue
          if (ended) return // a block failed, or the user cancelled meanwhile
          try {
            const { text } = await (await call(`${route}/stop`, { method: 'POST', signal })).json()
            if (ended) return
            if (typeof text === 'string' && text.trim()) onEvent({ type: 'final', text })
            end()
          } catch (error) {
            fail(error)
          }
        },
        cancel() {
          if (ended) return
          release()
          end()
        },
      }
    },
  }
}

/** @param {import('@rooks/sdk').ClientContext} ctx */
export async function apply(ctx) {
  // Imported here rather than at the top: the engines above then load in a
  // plain Node test, without the platform's modules.
  const { default: React } = await import('react')
  const h = React.createElement

  /**
   * The engine's settings panel: Settings → Interface → Voice dictation
   * paints it under the engine's card, where the user also chooses the
   * engine. No second registration in `settings.voice` is needed.
   */
  function Panel({ engine, destination }) {
    const [availability, setAvailability] = React.useState(null)
    React.useEffect(() => {
      let live = true
      engine.availability().then((answer) => { if (live) setAvailability(answer) })
      return () => { live = false }
    }, [])
    const status = availability === null ? 'Checking…'
      : availability.state === 'ready' ? 'Ready.'
      : availability.reason ?? 'Unavailable.'
    return h('div', { style: { display: 'grid', gap: 4 } },
      h('strong', null, engine.label),
      h('span', null, destination),
      h('span', null, status))
  }

  const page = createPageEngine()
  const daemon = createDaemonEngine((path, init) => ctx.api(path, init))
  const disposePage = ctx.slots.register(
    { slot: 'dictation.engine', key: page.id, dictation: page },
    () => h(Panel, { engine: page, destination: 'Your voice stays in this window.' }),
  )
  const disposeDaemon = ctx.slots.register(
    { slot: 'dictation.engine', key: daemon.id, dictation: daemon },
    () => h(Panel, { engine: daemon, destination: 'Your voice is sent to the daemon of the active machine.' }),
  )
  return () => {
    disposeDaemon()
    disposePage()
  }
}
