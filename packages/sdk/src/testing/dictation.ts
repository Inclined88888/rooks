/**
 * The bench of a dictation engine (`kind: dictation`, client API 14): fake
 * audio to feed it, a driver that runs a session the way the product does and
 * reports every breach of the contract, the checks the product's guard
 * applies, and a fake engine to test what sits around an engine.
 *
 *   import { test } from 'node:test';
 *   import { defineConformanceTests, dictationEngineChecks } from '@timon-ai/sdk/testing';
 *
 *   defineConformanceTests(test, dictationEngineChecks(createMyEngine(), {
 *     speech: readWavPcm(readFileSync('fixtures/bonjour.wav')),   // recorded, 16 kHz mono
 *     language: 'fr',
 *     transcript: /bonjour/i,
 *   }), '[my-engine]');
 *
 * Nothing here opens a microphone, a file or the network: an engine that needs
 * a model or a server is made ready by the test that calls the bench.
 */

import assert from 'node:assert/strict';
import type {
  DictationAvailability, DictationEngine, DictationErrorCode, DictationEvent, DictationInterim, DictationLanguages,
  DictationSession,
} from '../dictation.js';
import type { ConformanceCheck } from './types.js';

/** The only rate the product feeds: 16 kHz mono, Float32 in [-1, 1]. */
export const DICTATION_SAMPLE_RATE = 16_000;

/** Longest `text` one event may carry; a longer one is dropped by the product. */
export const DICTATION_TEXT_MAX = 20_000;

export const DICTATION_ERROR_CODES: readonly DictationErrorCode[] = Object.freeze([
  'unavailable', 'needs-setup', 'busy', 'crashed', 'decode-failed', 'network', 'denied',
] as const);

/** Same rule as the manifest's `dictation.engines[].id`: `register` refuses an id the manifest does not name. */
const ENGINE_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
/** BCP 47 primary subtag, as the product passes it (`fr`, `en`, `yue`). */
const LANGUAGE_RE = /^[a-z]{2,3}$/;
const INTERIMS: readonly DictationInterim[] = ['live', 'delayed', 'final-only'];
const LANGUAGE_MODES: readonly DictationLanguages['mode'][] = ['auto', 'forced', 'required'];
const AVAILABILITY_STATES: readonly DictationAvailability['state'][] = ['ready', 'needs-setup', 'unavailable'];

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── Fake audio ───────────────────────────────────────────────────────────────

function samplesFor(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`seconds must be a finite number ≥ 0, got ${seconds}`);
  return Math.round(seconds * DICTATION_SAMPLE_RATE);
}

/** Digital silence. What a muted microphone sends; an engine must write nothing for it. */
export function silencePcm(seconds: number): Float32Array {
  return new Float32Array(samplesFor(seconds));
}

/**
 * A voiced signal with the energy profile of speech: a 140 Hz fundamental and
 * two harmonics, opened and closed four times a second like syllables. Enough
 * for a voice detector or a segmenter; no recogniser will read words in it.
 * Deterministic: the same arguments give the same samples.
 */
export function speechLikePcm(seconds: number, options: { amplitude?: number; pitchHz?: number; syllablesPerSecond?: number } = {}): Float32Array {
  const { amplitude = 0.3, pitchHz = 140, syllablesPerSecond = 4 } = options;
  const out = new Float32Array(samplesFor(seconds));
  for (let i = 0; i < out.length; i += 1) {
    const t = i / DICTATION_SAMPLE_RATE;
    const envelope = 0.5 - 0.5 * Math.cos(2 * Math.PI * syllablesPerSecond * t);
    const voice = Math.sin(2 * Math.PI * pitchHz * t) + 0.5 * Math.sin(4 * Math.PI * pitchHz * t)
      + 0.25 * Math.sin(6 * Math.PI * pitchHz * t);
    out[i] = (amplitude * envelope * voice) / 1.75;
  }
  return out;
}

/** Joins pieces of PCM end to end. */
export function concatPcm(...parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** One utterance as a microphone hears it: a little silence, speech, then silence until the user stops. */
export function fakeUtterance(options: { lead?: number; speech?: number; tail?: number } = {}): Float32Array {
  const { lead = 0.3, speech = 1.5, tail = 0.5 } = options;
  return concatPcm(silencePcm(lead), speechLikePcm(speech), silencePcm(tail));
}

/** Cuts PCM into the blocks the product feeds, about 100 ms each; the last one may be shorter. Copies, never views. */
export function chunkPcm(pcm: Float32Array, chunkMs = 100): Float32Array[] {
  const size = Math.max(1, Math.round((chunkMs / 1000) * DICTATION_SAMPLE_RATE));
  const out: Float32Array[] = [];
  for (let at = 0; at < pcm.length; at += size) out.push(pcm.slice(at, at + size));
  return out;
}

/**
 * Samples of a WAV file, for feeding a recording to an engine. Accepts mono
 * 16 kHz only, in 16-bit PCM or 32-bit float (`WAVE_FORMAT_EXTENSIBLE` too):
 * resampling is not the bench's job (`ffmpeg -i in.wav -ac 1 -ar 16000 out.wav`).
 * Throws on anything else rather than guessing — a float file read as 16-bit
 * is noise, and an engine fed noise "fails" for a reason that is not its own.
 */
export function readWavPcm(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file (no RIFF/WAVE header)');
  let format: { code: number; channels: number; rate: number; bits: number } | null = null;
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (body + size > bytes.byteLength) throw new Error(`WAV chunk \`${id.trim()}\` runs past the end of the file`);
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV `fmt ` chunk is too short');
      let code = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (code === 0xfffe && size >= 26) code = view.getUint16(body + 24, true);
      format = { code, channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!format) throw new Error('WAV `data` chunk before its `fmt ` chunk');
      if (format.channels !== 1) throw new Error(`expected a mono WAV, got ${format.channels} channels`);
      if (format.rate !== DICTATION_SAMPLE_RATE) {
        throw new Error(`expected 16000 Hz, got ${format.rate} Hz: resample it first (ffmpeg -i in.wav -ac 1 -ar 16000 out.wav)`);
      }
      if (format.code === 1 && format.bits === 16) {
        const out = new Float32Array(Math.floor(size / 2));
        for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(body + i * 2, true) / 32768;
        return out;
      }
      if (format.code === 3 && format.bits === 32) {
        const out = new Float32Array(Math.floor(size / 4));
        for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat32(body + i * 4, true);
        return out;
      }
      throw new Error(`unsupported WAV encoding (format ${format.code}, ${format.bits} bits): expected 16-bit PCM or 32-bit float`);
    }
    at = body + size + (size % 2);
  }
  throw new Error('WAV file without a `data` chunk');
}

/** 16-bit PCM mono 16 kHz WAV of `pcm`, clipped to [-1, 1]: writes a fixture `readWavPcm` reads back. */
export function pcmToWav(pcm: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const write = (at: number, text: string) => { for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i); };
  write(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, DICTATION_SAMPLE_RATE, true); view.setUint32(28, DICTATION_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i += 1) {
    const s = Math.max(-1, Math.min(1, pcm[i] ?? 0));
    view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return bytes;
}

// ── The product's guard ──────────────────────────────────────────────────────

/**
 * Why the product would drop `event`, or `null` if it passes: an engine is an
 * untrusted source of text, so every event is checked before it reaches the
 * draft. Plain text only is the engine's duty; the product never renders it as HTML.
 */
export function dictationEventProblem(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return 'an event must be an object';
  const e = event as Record<string, unknown>;
  switch (e.type) {
    case 'partial':
    case 'final':
      if (typeof e.text !== 'string') return `a \`${e.type}\` needs a string \`text\``;
      if (e.text.length > DICTATION_TEXT_MAX) return `a \`${e.type}\` of ${e.text.length} characters (max ${DICTATION_TEXT_MAX})`;
      return null;
    case 'error':
      if (typeof e.code !== 'string' || !(DICTATION_ERROR_CODES as readonly string[]).includes(e.code)) {
        return `unknown error code \`${String(e.code)}\` (expected one of ${DICTATION_ERROR_CODES.join(', ')})`;
      }
      if (typeof e.message !== 'string' || e.message.length > DICTATION_TEXT_MAX) return 'an `error` needs a string `message`';
      if (typeof e.fatal !== 'boolean') return 'an `error` needs a boolean `fatal`';
      return null;
    case 'stopped':
      return null;
    default:
      return `unknown event type \`${String(e.type)}\``;
  }
}

/** Why the product would refuse to register `engine`, or `null`. */
export function dictationEngineProblem(engine: DictationEngine): string | null {
  if (typeof engine.id !== 'string' || !ENGINE_ID_RE.test(engine.id)) return `invalid engine id \`${String(engine.id)}\` (expected a slug: \`acme-whisper\`)`;
  if (typeof engine.label !== 'string' || !engine.label.trim()) return 'an engine needs a non-empty `label`';
  const { languages } = engine;
  if (!languages || !LANGUAGE_MODES.includes(languages.mode)) return `\`languages.mode\` must be one of ${LANGUAGE_MODES.join(', ')}`;
  if (!Array.isArray(languages.codes)) return '`languages.codes` must be an array';
  const bad = languages.codes.find((code) => typeof code !== 'string' || !LANGUAGE_RE.test(code));
  if (bad !== undefined) return `\`languages.codes\` holds \`${String(bad)}\`: expected a BCP 47 primary subtag (\`fr\`, \`en\`)`;
  if (languages.mode === 'required' && languages.codes.length === 0) return 'an engine whose language is `required` must list the codes it accepts';
  if (!INTERIMS.includes(engine.interim)) return `\`interim\` must be one of ${INTERIMS.join(', ')}`;
  if (typeof engine.availability !== 'function' || typeof engine.start !== 'function') return 'an engine needs `availability()` and `start()`';
  return null;
}

// ── Driving a session ────────────────────────────────────────────────────────

export type DictationRunOptions = {
  /** Passed to `start()`. Default `null` (automatic). */
  language?: string | null;
  /** Size of each `feed()`, in milliseconds of audio. Default 100, as the product. */
  chunkMs?: number;
  /** Pause between two feeds. Default 0: as fast as the engine takes it, yielding to the event loop each time. */
  paceMs?: number;
  /** How the session ends. Default `stop`. */
  end?: 'stop' | 'cancel' | 'abort';
  /** End after this much audio instead of all of it (ms). For `cancel` / `abort` mid-sentence. */
  endAfterMs?: number;
  /** How long to keep listening after the end for events that should not come, and for the `stopped` of a cancel or an abort. Default 100 ms. */
  settleMs?: number;
  /** Bound on `start()` and `stop()`. Default 10 s. */
  timeoutMs?: number;
};

export type DictationErrorEvent = Extract<DictationEvent, { type: 'error' }>;

/** What one session produced, and what it did wrong. */
export type DictationRun = {
  /** Every event the engine emitted, in order, valid or not. */
  readonly events: readonly unknown[];
  /** Breaches of the contract, in plain words; empty when the engine behaved. */
  readonly problems: readonly string[];
  readonly partials: readonly string[];
  readonly finals: readonly string[];
  readonly errors: readonly DictationErrorEvent[];
  /** The finals as the product appends them to the draft: trimmed, joined by a space. */
  readonly text: string;
  /** Whether a `stopped` event arrived. */
  readonly stopped: boolean;
};

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Runs one session the way the product does — `start`, ~100 ms feeds, then
 * `stop`, `cancel` or an abort of the signal — and records what the engine
 * emitted. A `start()` that rejects rejects here; everything else the engine
 * gets wrong is listed in `problems`, so a test can assert on all of it at once.
 */
export async function runDictation(engine: DictationEngine, pcm: Float32Array, options: DictationRunOptions = {}): Promise<DictationRun> {
  const { language = null, chunkMs = 100, paceMs = 0, end = 'stop', endAfterMs, settleMs = 100, timeoutMs = 10_000 } = options;
  const events: unknown[] = [];
  const problems: string[] = [];
  const partials: string[] = [];
  const finals: string[] = [];
  const errors: DictationErrorEvent[] = [];
  let stoppedCount = 0;
  let phase: 'running' | 'ending' | 'stop-resolved' | 'cancelled' = 'running';
  const controller = new AbortController();

  const onEvent = (event: DictationEvent): void => {
    events.push(event);
    const problem = dictationEventProblem(event);
    if (problem) { problems.push(`invalid event: ${problem}`); return; }
    if (stoppedCount > 0) { problems.push(`a \`${event.type}\` arrived after \`stopped\` (the product ignores it)`); return; }
    switch (event.type) {
      case 'partial':
        if (phase === 'stop-resolved') problems.push('a `partial` arrived after `stop()` resolved');
        partials.push(event.text);
        break;
      case 'final':
        if (phase === 'cancelled') problems.push(`a \`final\` ("${event.text.slice(0, 60)}") arrived after the session was cancelled`);
        if (phase === 'stop-resolved') problems.push('a `final` arrived after `stop()` resolved: it must resolve after the last final');
        finals.push(event.text);
        break;
      case 'error':
        errors.push(event);
        break;
      case 'stopped':
        stoppedCount += 1;
        break;
    }
  };

  const session: DictationSession = await withTimeout(
    engine.start({ language, signal: controller.signal, onEvent }), timeoutMs, 'start()');
  const limit = endAfterMs === undefined ? pcm.length : Math.min(pcm.length, Math.round((endAfterMs / 1000) * DICTATION_SAMPLE_RATE));
  for (const chunk of chunkPcm(pcm.subarray(0, limit), chunkMs)) {
    if (stoppedCount > 0) break; // the engine ended the session itself (a fatal error)
    try { session.feed(chunk); } catch (error) { problems.push(`feed() threw: ${describe(error)}`); break; }
    await pause(paceMs);
  }

  phase = 'ending';
  if (end === 'stop') {
    try {
      await withTimeout(session.stop(), timeoutMs, 'stop()');
    } catch (error) {
      problems.push(`stop() failed: ${describe(error)}`);
    }
    phase = 'stop-resolved';
  } else {
    phase = 'cancelled';
    try {
      if (end === 'cancel') session.cancel(); else controller.abort();
    } catch (error) {
      problems.push(`${end === 'cancel' ? 'cancel()' : 'the abort listener'} threw: ${describe(error)}`);
    }
  }
  await pause(settleMs);

  // `stopped` is the last event of EVERY session: a bench that only asked for
  // it after stop() let an engine whose cancel() goes silent pass.
  if (stoppedCount === 0) {
    problems.push(end === 'stop'
      ? 'no `stopped` event: it must close every session'
      : `no \`stopped\` event after ${end === 'cancel' ? 'cancel()' : 'the abort'}: it must close every session, cancelled ones too`);
  }
  if (stoppedCount > 1) problems.push(`${stoppedCount} \`stopped\` events: there must be exactly one`);
  return {
    events, problems, partials, finals, errors, stopped: stoppedCount > 0,
    text: finals.map((text) => text.trim()).filter(Boolean).join(' '),
  };
}

// ── The checks ───────────────────────────────────────────────────────────────

export type DictationExpectation = {
  /** What to dictate. Default `fakeUtterance()`; give a recording (`readWavPcm`) to check real words. */
  speech?: Float32Array;
  /** Language handed to `start()`. Default: the engine's first code, or `null`. */
  language?: string | null;
  /** Checked against the text of the dictation, when given. */
  transcript?: string | RegExp;
  /** Check that silence gives no text (default `true`). Turn off only for an engine that cannot tell. */
  silence?: boolean;
  /** Your `package.json`: the engine's `id` must be one of its `timon.dictation.engines`. */
  manifest?: unknown;
  /** Passed to every session (`paceMs`, `timeoutMs`, `settleMs`…). */
  run?: Omit<DictationRunOptions, 'language' | 'end' | 'endAfterMs'>;
};

function manifestEngineIds(manifest: unknown): string[] | null {
  const timon = (manifest as { timon?: { dictation?: { engines?: unknown } } } | null)?.timon;
  const engines = timon?.dictation?.engines;
  if (!Array.isArray(engines)) return null;
  return engines.map((e) => (e as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string');
}

/**
 * The contract the product holds every engine to, as checks for your test
 * runner (`defineConformanceTests`). Session checks need the engine `ready`:
 * fake its model or its server in the test, the bench never downloads anything.
 */
export function dictationEngineChecks(engine: DictationEngine, expectation: DictationExpectation = {}): ConformanceCheck[] {
  const speech = expectation.speech ?? fakeUtterance();
  const language = expectation.language !== undefined ? expectation.language : (engine.languages?.codes?.[0] ?? null);
  const base: DictationRunOptions = { ...expectation.run, language };
  const halfway = Math.round((speech.length / DICTATION_SAMPLE_RATE) * 500);

  const ready = async (): Promise<void> => {
    const { state, reason } = await engine.availability();
    if (state !== 'ready') {
      throw new Error(`availability() is \`${state}\`${reason ? ` (${reason})` : ''}: make the engine ready for the bench (fake its model or server)`);
    }
  };
  const clean = (run: DictationRun, what: string): void => {
    assert.deepEqual(run.problems, [], `${what}: the engine broke the contract`);
  };

  const checks: ConformanceCheck[] = [
    {
      name: 'declares an id, a label, its languages and its interim mode as the product registers them',
      run() {
        const problem = dictationEngineProblem(engine);
        assert.equal(problem, null, problem ?? '');
        if (expectation.manifest !== undefined) {
          const ids = manifestEngineIds(expectation.manifest);
          assert.ok(ids, 'the manifest has no `timon.dictation.engines`');
          assert.ok(ids.includes(engine.id), `engine \`${engine.id}\` is not declared in the manifest (${ids.join(', ') || 'none'}): register() would throw`);
        }
      },
    },
    {
      name: 'availability() answers ready, needs-setup or unavailable, with a plain-text reason',
      async run() {
        const answer = await engine.availability();
        assert.ok(AVAILABILITY_STATES.includes(answer?.state), `availability() answered \`${String(answer?.state)}\``);
        if (answer.reason !== undefined) assert.equal(typeof answer.reason, 'string', '`reason` must be a string');
      },
    },
    {
      name: 'a dictation ends with exactly one `stopped`, last, and every event fits the contract',
      async run() {
        await ready();
        const run = await runDictation(engine, speech, base);
        clean(run, 'dictation');
        assert.equal(run.stopped, true);
        assert.equal((run.events.at(-1) as DictationEvent | undefined)?.type, 'stopped', '`stopped` must be the last event');
        if (engine.interim === 'final-only') {
          assert.deepEqual(run.partials, [], 'an engine declared `final-only` emitted `partial` events');
        }
        if (expectation.transcript !== undefined) {
          const want = expectation.transcript;
          if (typeof want === 'string') assert.equal(run.text, want);
          else assert.match(run.text, want);
        }
      },
    },
    {
      name: 'cancel() drops what is pending: no `final` follows, `stopped` closes it',
      async run() {
        await ready();
        clean(await runDictation(engine, speech, { ...base, end: 'cancel', endAfterMs: halfway }), 'cancel');
      },
    },
    {
      name: 'aborting the start signal ends the session like cancel()',
      async run() {
        await ready();
        clean(await runDictation(engine, speech, { ...base, end: 'abort', endAfterMs: halfway }), 'abort');
      },
    },
    {
      name: 'a second dictation works like the first (no state left behind)',
      async run() {
        await ready();
        const first = await runDictation(engine, speech, base);
        const second = await runDictation(engine, speech, base);
        clean(first, 'first dictation');
        clean(second, 'second dictation');
        assert.equal(second.stopped, true);
        const want = expectation.transcript;
        if (typeof want === 'string') assert.equal(second.text, want, 'the second dictation of the same audio');
        else if (want) assert.match(second.text, want, 'the second dictation of the same audio');
      },
    },
  ];
  if (expectation.silence !== false) {
    checks.push({
      name: 'silence gives no text (no "Thank you." on a quiet microphone)',
      async run() {
        await ready();
        const run = await runDictation(engine, silencePcm(1.5), base);
        clean(run, 'silence');
        const heard = [...run.partials, ...run.finals].map((text) => text.trim()).filter(Boolean);
        assert.deepEqual(heard, [], 'text on silence lands in the user\'s draft: filter what the model invents');
      },
    });
  }
  return checks;
}

// ── A fake engine ────────────────────────────────────────────────────────────

/** What the fake engine heard so far, handed to `transcribe`. */
export type FakeHearing = { readonly language: string | null; readonly samples: number; readonly voicedMs: number };

export type FakeDictationSessionRecord = {
  readonly language: string | null;
  /** Samples received through `feed()`. */
  samples: number;
  feeds: number;
  voicedMs: number;
  ended: 'stop' | 'cancel' | 'abort' | 'error' | null;
};

export type FakeDictationEngineOptions = {
  id?: string;
  label?: string;
  languages?: DictationLanguages;
  interim?: DictationInterim;
  availability?: DictationAvailability;
  /** The text for what was heard. Default: nothing on silence, `fake transcript (1.5 s of speech)` otherwise. */
  transcribe?: (heard: FakeHearing) => string;
  /** Make `start()` reject, or emit an error after some audio (fatal by default, which ends the session). */
  fail?: { on: 'start'; message?: string } | { on: 'feed'; afterMs?: number; code?: DictationErrorCode; message?: string; fatal?: boolean };
};

export type FakeDictationEngine = DictationEngine & {
  /** One record per `start()`, in order: what the engine received and how the session ended. */
  readonly sessions: readonly FakeDictationSessionRecord[];
};

/** RMS above which a block counts as voiced: well under speech, well over a quiet room. */
const VOICED_RMS = 0.01;

function rms(pcm: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) { const s = pcm[i] ?? 0; sum += s * s; }
  return pcm.length ? Math.sqrt(sum / pcm.length) : 0;
}

const defaultTranscribe = ({ voicedMs }: FakeHearing): string =>
  voicedMs > 0 ? `fake transcript (${(voicedMs / 1000).toFixed(1)} s of speech)` : '';

/**
 * An engine that follows the contract to the letter and recognises nothing:
 * its text only says how much voiced audio it heard. For testing what sits
 * around an engine (a settings panel, a wrapper engine, the bench itself), and
 * as a reading of the contract in fifty lines.
 */
export function createFakeDictationEngine(options: FakeDictationEngineOptions = {}): FakeDictationEngine {
  const transcribe = options.transcribe ?? defaultTranscribe;
  const sessions: FakeDictationSessionRecord[] = [];
  const interim = options.interim ?? 'live';
  return {
    id: options.id ?? 'fake-dictation',
    label: options.label ?? 'Fake dictation',
    languages: options.languages ?? { codes: ['en', 'fr'], mode: 'forced' },
    interim,
    sessions,
    async availability() { return options.availability ?? { state: 'ready' }; },
    async start({ language, signal, onEvent }) {
      if (options.fail?.on === 'start') throw new Error(options.fail.message ?? 'fake start failure');
      const record: FakeDictationSessionRecord = { language, samples: 0, feeds: 0, voicedMs: 0, ended: null };
      sessions.push(record);
      let sinceInterim = 0;
      const heard = (): FakeHearing => ({ language, samples: record.samples, voicedMs: record.voicedMs });
      const finish = (how: NonNullable<FakeDictationSessionRecord['ended']>): void => {
        record.ended = how;
        signal.removeEventListener('abort', onAbort);
        onEvent({ type: 'stopped' });
      };
      const onAbort = (): void => { if (!record.ended) finish('abort'); };
      signal.addEventListener('abort', onAbort);
      return {
        feed(pcm) {
          if (record.ended) return;
          record.samples += pcm.length;
          record.feeds += 1;
          const ms = (pcm.length / DICTATION_SAMPLE_RATE) * 1000;
          if (rms(pcm) > VOICED_RMS) record.voicedMs += ms;
          const fail = options.fail;
          if (fail?.on === 'feed' && (record.samples / DICTATION_SAMPLE_RATE) * 1000 >= (fail.afterMs ?? 0)) {
            const fatal = fail.fatal ?? true;
            onEvent({ type: 'error', code: fail.code ?? 'crashed', message: fail.message ?? 'fake engine failure', fatal });
            if (fatal) { finish('error'); return; }
          }
          sinceInterim += ms;
          const due = interim === 'live' || (interim === 'delayed' && sinceInterim >= 1000);
          const text = due ? transcribe(heard()) : '';
          if (text) { sinceInterim = 0; onEvent({ type: 'partial', text }); }
        },
        async stop() {
          if (record.ended) return;
          await Promise.resolve();
          const text = transcribe(heard());
          if (text) onEvent({ type: 'final', text });
          finish('stop');
        },
        cancel() {
          if (!record.ended) finish('cancel');
        },
      };
    },
  };
}
