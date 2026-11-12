import { cleanTranscript, type HallucinationProfile } from './speech-hallucinations.js';
import { interimPolicy, SpeechSegmenter, type InterimPolicy, type SegmenterOptions } from './speech-segmenter.js';
import { workerInputSchema, type WorkerInit, type WorkerOutput } from './speech-protocol.js';

/**
 * The dictation logic of the utility process, without the native addon:
 * segmentation, decoding through a `Recognizer`, the hallucination filter,
 * and the session contract. `speech-worker.mts` plugs sherpa-onnx in; tests
 * plug a fake recognizer.
 *
 * One session at a time. Every output carries its session id and nothing is
 * emitted for a session once it is stopped or replaced, so a late result can
 * never land in the draft of a newer dictation.
 */

export interface Recognizer {
  /** Text of one utterance (16 kHz mono PCM, -1..1). */
  decode(samples: Float32Array): string;
}

export type SessionOptions = {
  recognizer: Recognizer;
  emit: (message: WorkerOutput) => void;
  segmenter: SegmenterOptions;
  /** The anti-hallucination profile of the model's family; `nemo` when absent. */
  filter?: HallucinationProfile;
  /** No language imposed at load: the model detects it, and may hear English in a short fragment. */
  languageDetected?: boolean;
};

/** Microphones can deliver NaN or out-of-range values; the native side must never see them. */
export function sanitizeSamples(samples: Float32Array): Float32Array {
  let clean: Float32Array | null = null;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] as number;
    const fixed = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    if (fixed !== v) {
      clean ??= Float32Array.from(samples);
      clean[i] = fixed;
    }
  }
  return clean ?? samples;
}

export class DictationSession {
  private readonly recognizer: Recognizer;
  private readonly emit: (message: WorkerOutput) => void;
  private readonly segmenter: SpeechSegmenter;
  private readonly filter: HallucinationProfile;
  private readonly languageDetected: boolean;
  private current: string | null = null;
  private lastPartial = '';

  constructor(options: SessionOptions) {
    this.recognizer = options.recognizer;
    this.emit = options.emit;
    this.segmenter = new SpeechSegmenter(options.segmenter);
    this.filter = options.filter ?? 'nemo';
    this.languageDetected = options.languageDetected ?? false;
  }

  get sessionId(): string | null { return this.current; }

  /**
   * Opens a session; a session still open is dropped without its pending text.
   * `interim` is what the main process chose (the model's mode, the user's
   * choice); the floor of a detected language is applied here again, so no
   * caller can bring back the early partials that flip Parakeet to English.
   */
  start(sessionId: string, interim: InterimPolicy = { mode: 'live', minUtteranceMs: 0 }): void {
    if (this.current && this.current !== sessionId) this.emit({ type: 'stopped', sessionId: this.current });
    this.current = sessionId;
    this.lastPartial = '';
    this.segmenter.reset();
    this.segmenter.setInterim(interimPolicy(interim, { languageDetected: this.languageDetected }));
  }

  feed(sessionId: string, samples: Float32Array): void {
    if (sessionId !== this.current) return;
    for (const event of this.segmenter.push(sanitizeSamples(samples))) {
      const text = this.decode(sessionId, event.audio, event.stats);
      if (text === undefined) continue;
      if (event.type === 'final') {
        this.lastPartial = '';
        if (text) this.emit({ type: 'final', sessionId, text });
      } else if (text && text !== this.lastPartial) {
        this.lastPartial = text;
        this.emit({ type: 'partial', sessionId, text });
      }
    }
  }

  /** Decodes what remains, emits its final, then `stopped`. */
  stop(sessionId: string): void {
    if (sessionId !== this.current) {
      // Answer anyway: the caller waits on `stopped`, and this session is already over.
      this.emit({ type: 'stopped', sessionId });
      return;
    }
    const rest = this.segmenter.flush();
    if (rest) {
      const text = this.decode(sessionId, rest.audio, rest.stats);
      if (text) this.emit({ type: 'final', sessionId, text });
    }
    this.close(sessionId);
  }

  /** Drops the session and its pending audio, without a final. */
  cancel(sessionId: string): void {
    if (sessionId !== this.current) {
      this.emit({ type: 'stopped', sessionId });
      return;
    }
    this.segmenter.reset();
    this.close(sessionId);
  }

  private close(sessionId: string): void {
    this.current = null;
    this.lastPartial = '';
    this.emit({ type: 'stopped', sessionId });
  }

  /** The cleaned text ('' when filtered out), or undefined when decoding failed. */
  private decode(sessionId: string, audio: Float32Array, stats: { voicedMs: number; totalMs: number }): string | undefined {
    let raw: string;
    try {
      raw = this.recognizer.decode(audio);
    } catch (error) {
      this.emit({ type: 'error', sessionId, code: 'decode-failed', message: (error as Error)?.message?.slice(0, 500) ?? 'Decoding failed.' });
      return undefined;
    }
    return cleanTranscript(raw, stats, this.filter) ?? '';
  }
}

export type WorkerHandlerOptions = {
  makeRecognizer: (init: WorkerInit) => Recognizer;
  send: (message: WorkerOutput) => void;
  /** Overrides of the segmenter defaults (tests). */
  segmenter?: Omit<SegmenterOptions, 'sampleRate'>;
};

/**
 * The message loop of the utility process, apart from the transport: every
 * input is parsed before it reaches the session or the native addon.
 */
export function createWorkerHandler(options: WorkerHandlerOptions): (raw: unknown) => void {
  let session: DictationSession | null = null;
  return (raw) => {
    const parsed = workerInputSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case 'init':
        if (session) return;
        try {
          session = new DictationSession({
            recognizer: options.makeRecognizer(message),
            emit: options.send,
            filter: message.filter,
            languageDetected: message.language === null,
            segmenter: { ...options.segmenter, sampleRate: message.sampleRate },
          });
          options.send({ type: 'ready' });
        } catch (error) {
          options.send({ type: 'init-failed', message: String((error as Error)?.message ?? error).slice(0, 2000) });
        }
        return;
      case 'start':
        session?.start(message.sessionId, message.interim);
        return;
      case 'feed':
        session?.feed(message.sessionId, message.samples);
        return;
      case 'stop':
      case 'cancel':
        if (!session) options.send({ type: 'stopped', sessionId: message.sessionId });
        else if (message.type === 'stop') session.stop(message.sessionId);
        else session.cancel(message.sessionId);
        return;
    }
  };
}
