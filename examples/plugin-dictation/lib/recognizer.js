/**
 * The stand-in for a speech recogniser, shared by nothing but the host half.
 * It hears how much voiced audio arrived and says so; it never invents text
 * on silence, which is the one behaviour of it to keep.
 *
 * Replace `createRecognizer` with yours, and say where the voice goes:
 *  - a local program: run it with `ctx.exec` (permission `host:exec`); the
 *    operator authorizes it at install. `egress` stays `daemon`.
 *  - a service: call it with `ctx.fetch` (permission `http:outbound`, its host
 *    in the operator's `pluginPolicy.http.allow`), its key from `ctx.secrets`,
 *    never in a URL or a log. `egress` becomes the list of its hosts
 *    (`["api.acme.com"]`): the install sheet shows it to the user.
 */

const SAMPLE_RATE = 16_000
/** 100 ms frames, judged voiced above this RMS: well under speech, well over a quiet room. */
const FRAME = SAMPLE_RATE / 10
const VOICED_RMS = 0.01

/** @param {{ language: string | null }} options */
export function createRecognizer({ language }) {
  let voicedFrames = 0
  /** @type {number[]} */
  let pending = []
  return {
    /** @param {Float32Array} pcm 16 kHz mono, in [-1, 1] */
    accept(pcm) {
      for (const sample of pcm) {
        pending.push(sample)
        if (pending.length < FRAME) continue
        const rms = Math.sqrt(pending.reduce((sum, s) => sum + s * s, 0) / FRAME)
        if (rms > VOICED_RMS) voicedFrames += 1
        pending = []
      }
    },
    /** The final text: empty when nothing was said. */
    finish() {
      if (!voicedFrames) return ''
      const seconds = (voicedFrames / 10).toFixed(1)
      return `Example transcript: ${seconds} s of speech${language ? ` (${language})` : ''}.`
    },
  }
}
