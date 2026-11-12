import type { SegmentStats } from './speech-hallucinations.js';

/**
 * Cuts a microphone stream into utterances for an OFFLINE recognizer.
 *
 * Parakeet TDT is not a streaming model: it decodes a whole buffer at once and
 * has no partial results of its own. Live text is therefore produced by
 * re-decoding the utterance in progress at a bounded pace (`partial`), and an
 * utterance is committed (`final`) after a pause or at a length limit. Speech
 * is detected by frame energy against an adaptive noise floor, which needs no
 * second model (Silero VAD would). Audio without enough voiced frames is never
 * handed to the recognizer, which is the first defence against invented text.
 *
 * Bounded by construction: an utterance never exceeds `maxUtteranceMs`, so a
 * decode never grows with the length of the dictation (Orca hit a 2 GiB ONNX
 * allocation that killed the app by decoding one unbounded capture).
 */

export type SegmenterOptions = {
  sampleRate: number;
  frameMs?: number;
  /** Minimum RMS treated as speech, whatever the noise floor (-40 dBFS). */
  minSpeechRms?: number;
  /** Speech must stand this many times above the noise floor. */
  noiseRatio?: number;
  /** Silence that ends an utterance. */
  endSilenceMs?: number;
  maxUtteranceMs?: number;
  /** Audio kept before the first voiced frame, so a soft onset is not clipped. */
  preRollMs?: number;
  /** An utterance with less voiced audio than this is noise, never decoded. */
  minVoicedMs?: number;
  /** Shortest interval between two partial decodes, in audio time. */
  partialEveryMs?: number;
  /** When partial text may appear; `live` from the first second when absent. */
  interim?: InterimPolicy;
};

/**
 * How early a model shows provisional text. `live` re-decodes the utterance
 * as it grows; `delayed` waits for {@link DELAYED_INTERIM_MS} of it, for
 * models whose decoding takes a second or more (a partial every second would
 * queue up behind the speaker); `final-only` shows text after the pause only.
 */
export const INTERIM_MODES = ['live', 'delayed', 'final-only'] as const;
export type InterimMode = typeof INTERIM_MODES[number];
export type InterimPolicy = { mode: InterimMode; minUtteranceMs: number };

/** A delayed partial waits for this much utterance, and the next one as long. */
export const DELAYED_INTERIM_MS = 3000;
/**
 * A model that detects the language may hear English in a shorter fragment of
 * any language: 5 of 24 French fragments at 1 s, none from 2 s (TODO #482).
 */
export const DETECTED_LANGUAGE_INTERIM_MS = 2000;

const INTERIM_RANK: Record<InterimMode, number> = { live: 0, delayed: 1, 'final-only': 2 };

/**
 * The provisional text of a dictation: the model's own mode, made stricter by
 * the user's choice but never looser (a `live` choice cannot make a slow
 * model keep up), then floored for what the mode and the language demand.
 * Nothing here comes from the model's data alone: a catalog entry that asks
 * for early partials while detecting the language still gets the 2 s floor.
 */
export function interimPolicy(
  model: { mode: InterimMode; minUtteranceMs?: number },
  options: { user?: InterimMode | 'auto'; languageDetected: boolean },
): InterimPolicy {
  const user = options.user && options.user !== 'auto' ? options.user : model.mode;
  const mode = INTERIM_RANK[user] > INTERIM_RANK[model.mode] ? user : model.mode;
  const minUtteranceMs = Math.max(
    model.minUtteranceMs ?? 0,
    mode === 'delayed' ? DELAYED_INTERIM_MS : 0,
    options.languageDetected ? DETECTED_LANGUAGE_INTERIM_MS : 0,
  );
  return { mode, minUtteranceMs };
}

export type Segment = { audio: Float32Array; stats: SegmentStats };
export type SegmentEvent = { type: 'partial' | 'final' } & Segment;

function concat(chunks: readonly Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] as number;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

export class SpeechSegmenter {
  private readonly frameSamples: number;
  private readonly frameMs: number;
  private readonly minSpeechRms: number;
  private readonly noiseRatio: number;
  private readonly endSilenceFrames: number;
  private readonly maxFrames: number;
  private readonly preRollFrames: number;
  private readonly minVoicedFrames: number;
  private readonly partialEveryMs: number;
  private interim: InterimPolicy;

  private pending = new Float32Array(0);
  private preRoll: Float32Array[] = [];
  private utterance: Float32Array[] = [];
  private inSpeech = false;
  private voicedFrames = 0;
  private silenceRun = 0;
  private lastPartialFrames = 0;
  /** Indexes, in `utterance`, of the first and the latest voiced frame. */
  private speechStart = 0;
  private lastVoiced = 0;
  private noiseFloor: number;

  constructor(options: SegmenterOptions) {
    this.frameMs = options.frameMs ?? 30;
    this.frameSamples = Math.max(1, Math.round((options.sampleRate * this.frameMs) / 1000));
    this.minSpeechRms = options.minSpeechRms ?? 0.01;
    this.noiseRatio = options.noiseRatio ?? 3;
    const frames = (ms: number): number => Math.max(1, Math.round(ms / this.frameMs));
    this.endSilenceFrames = frames(options.endSilenceMs ?? 800);
    this.maxFrames = frames(options.maxUtteranceMs ?? 20_000);
    this.preRollFrames = frames(options.preRollMs ?? 300);
    this.minVoicedFrames = frames(options.minVoicedMs ?? 240);
    this.partialEveryMs = options.partialEveryMs ?? 1000;
    this.interim = options.interim ?? { mode: 'live', minUtteranceMs: 0 };
    this.noiseFloor = this.minSpeechRms / this.noiseRatio;
  }

  /** Feeds samples; returns the utterances finished and, at most, one partial. */
  push(samples: Float32Array): SegmentEvent[] {
    const events: SegmentEvent[] = [];
    let partial: SegmentEvent | null = null;
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending, 0);
    joined.set(samples, this.pending.length);
    let offset = 0;
    for (; offset + this.frameSamples <= joined.length; offset += this.frameSamples) {
      const frame = joined.slice(offset, offset + this.frameSamples);
      const ended = this.frame(frame);
      if (ended) {
        partial = null;
        if (ended.stats.voicedMs >= this.minVoicedFrames * this.frameMs) events.push({ type: 'final', ...ended });
      } else if (this.inSpeech && this.voicedFrames >= this.minVoicedFrames && this.dueForPartial()) {
        this.lastPartialFrames = this.utterance.length;
        partial = { type: 'partial', ...this.snapshot() };
      }
    }
    this.pending = joined.slice(offset);
    if (partial) events.push(partial);
    return events;
  }

  /** Ends the stream: the utterance in progress, if it holds speech. */
  flush(): Segment | null {
    if (this.pending.length > 0 && this.inSpeech) this.utterance.push(this.pending);
    this.pending = new Float32Array(0);
    const segment = this.inSpeech && this.voicedFrames >= this.minVoicedFrames ? this.snapshot() : null;
    this.reset();
    return segment;
  }

  /** Applies from the next partial on; a session sets its own before any audio. */
  setInterim(policy: InterimPolicy): void {
    this.interim = policy;
  }

  reset(): void {
    this.pending = new Float32Array(0);
    this.preRoll = [];
    this.utterance = [];
    this.inSpeech = false;
    this.voicedFrames = 0;
    this.silenceRun = 0;
    this.lastPartialFrames = 0;
    this.speechStart = 0;
    this.lastVoiced = 0;
  }

  /**
   * Re-decoding costs more as the utterance grows: space partials out with it.
   * The minimum length is that of the speech, onset to latest voiced frame:
   * the pre-roll and a closing pause would let 1.5 s of words through as a
   * "2 s" fragment, which is exactly what flips Parakeet to English.
   */
  private dueForPartial(): boolean {
    if (this.interim.mode === 'final-only') return false;
    if ((this.lastVoiced - this.speechStart + 1) * this.frameMs < this.interim.minUtteranceMs) return false;
    const length = this.utterance.length * this.frameMs;
    const every = this.interim.mode === 'delayed' ? Math.max(this.partialEveryMs, DELAYED_INTERIM_MS) : this.partialEveryMs;
    const since = (this.utterance.length - this.lastPartialFrames) * this.frameMs;
    return since >= Math.max(every, length / 4);
  }

  private snapshot(): Segment {
    const length = this.utterance.reduce((n, c) => n + c.length, 0);
    return {
      audio: concat(this.utterance, length),
      stats: { voicedMs: this.voicedFrames * this.frameMs, totalMs: Math.round((length / this.frameSamples) * this.frameMs) },
    };
  }

  /** Returns the utterance this frame closed, if any. */
  private frame(frame: Float32Array): Segment | null {
    const level = rms(frame);
    const voiced = level >= Math.max(this.minSpeechRms, this.noiseFloor * this.noiseRatio);
    // The floor drops fast and rises slowly (~30 s): the gaps between words
    // keep it low while someone speaks, a steady fan or hum lifts it until it
    // no longer counts as speech.
    this.noiseFloor = level < this.noiseFloor
      ? this.noiseFloor * 0.7 + level * 0.3
      : this.noiseFloor * 0.999 + level * 0.001;
    this.noiseFloor = Math.max(this.noiseFloor, 1e-4);
    if (!this.inSpeech) {
      if (!voiced) {
        this.preRoll.push(frame);
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
        return null;
      }
      this.inSpeech = true;
      this.utterance = [...this.preRoll, frame];
      this.speechStart = this.preRoll.length;
      this.lastVoiced = this.speechStart;
      this.preRoll = [];
      this.voicedFrames = 1;
      this.silenceRun = 0;
      this.lastPartialFrames = 0;
      return null;
    }
    this.utterance.push(frame);
    if (voiced) {
      this.voicedFrames += 1;
      this.silenceRun = 0;
      this.lastVoiced = this.utterance.length - 1;
    } else {
      this.silenceRun += 1;
    }
    if (this.silenceRun >= this.endSilenceFrames) {
      const segment = this.snapshot();
      this.reset();
      return segment;
    }
    if (this.utterance.length >= this.maxFrames) {
      // Speech goes on: the next frame opens the following utterance at once.
      const segment = this.snapshot();
      this.utterance = [];
      this.voicedFrames = 0;
      this.silenceRun = 0;
      this.lastPartialFrames = 0;
      this.speechStart = 0;
      this.lastVoiced = -1;
      return segment;
    }
    return null;
  }
}
