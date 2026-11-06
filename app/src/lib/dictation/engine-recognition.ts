import { composerDictee } from '@/lib/stt-dictee';

import { CaptureError, type CaptureHandlers, type MicrophoneCapture } from './audio-capture';
import {
  DICTATION_SAMPLE_RATE, readDictationEvent,
  type DictationAvailability, type DictationEngine, type DictationErrorCode, type DictationSession,
} from './contract';
import { readAvailability } from './engines';
import type { LocalFatalError } from './errors';
import type { MicrophoneStatus } from './microphone';

/**
 * A dictation engine (`DictationEngine`, client API 14, TODO #484) behind the
 * shape of a Web Speech `SpeechRecognition`: `start` / `stop` / `abort`,
 * `onresult` / `onerror` / `onend`. The chat composer and the cockpit's voice
 * mode keep their own logic (draft base, segment folding, silence timer) and
 * only swap the object that produces results.
 *
 * The product holds what the contract keeps from an engine: the microphone
 * (opened here, after the OS's answer, never by the engine), the 16 kHz
 * capture, the session's identity (an event of a run that ended is dropped,
 * whatever the engine believes) and the check of every event against the
 * contract — one out of schema, or one after `stopped`, is ignored.
 *
 * Segment fusion — why the local engine does NOT feed its utterances through
 * `fusionnerSegments` (lib/stt-transcript). That function repairs engines that
 * re-emit the WHOLE sentence at every event (Android): a segment that starts
 * with everything said so far replaces it, one already at the end is dropped.
 * A contract engine is the opposite by construction (the sherpa one cuts
 * DISJOINT utterances on silence): a `partial` is replaced by the next one and
 * a `final` is to append (docs/DICTATION.md). On disjoint utterances those two
 * rules eat real speech: "We have to test." then "We have to test again."
 * would lose the first sentence, a "Thanks." said twice would keep one. So the
 * finals are joined here, plainly (`composerDictee`), and the consumers receive
 * at most ONE final result (the joined finals) and ONE interim (the current
 * partial). Their own `texteSession` / `lireResultats` still run, but over a
 * single final segment they are the identity; the only fusion left is between
 * the finals and the live partial, which is transient — the next final
 * replaces it with the plain join.
 */

export type RecognitionResultList = ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
export type RecognitionResultEvent = { resultIndex: number; results: RecognitionResultList };
export type RecognitionErrorEvent = { error: string; message?: string };

/** What both surfaces need from a recognizer: Web Speech's or ours. */
export type RecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  /** The engine listens from here on (Web Speech has it too). */
  onstart?: (() => void) | null;
};


/** Audio captured while the engine loads (~2 s the first time) is kept, up to this. */
const MAX_BUFFERED_SAMPLES = DICTATION_SAMPLE_RATE * 30;
/** An engine whose `stop` never resolves is cancelled after this: the surface must not stay "listening". */
export const STOP_DEADLINE_MS = 30_000;

export type EngineRecognitionDeps = {
  engine: DictationEngine;
  capture: (handlers: CaptureHandlers) => Promise<MicrophoneCapture>;
  /** The OS's answer about the microphone; `request` may prompt. */
  microphone: (request: boolean) => Promise<MicrophoneStatus>;
  /** Defaults to the engine store's guarded read. */
  availability?: (engine: DictationEngine) => Promise<DictationAvailability | null>;
  /**
   * The user's consent to this engine (`consent-gate.ts`), asked before
   * anything else: an engine that is not `go` gets neither the microphone nor
   * a start. Absent: no consent to ask (a test, a product-only surface).
   */
  admit?: () => EngineAdmission;
};

/**
 * `go`: consented, or the product's own engine. `asked`: the consent card is
 * open. `refused`: the user said no, or nothing could ask. `undeclared`: its
 * plugin names no destination for it.
 */
export type EngineAdmission = 'go' | 'asked' | 'refused' | 'undeclared';

type Phase = 'idle' | 'starting' | 'running' | 'stopping' | 'ended';
type RecognitionError = LocalFatalError | 'not-allowed' | 'audio-capture' | 'aborted';

/**
 * What the product says of an engine's fatal error. `needs-setup` with an
 * empty message: the engine is showing its own setup (the local engine's
 * consent card), nothing to add.
 */
function fatalError(code: DictationErrorCode, message: string, starting: boolean): LocalFatalError {
  switch (code) {
    case 'needs-setup':
      return message ? 'model-missing' : 'model-consent';
    case 'unavailable':
    case 'denied':
      return 'engine-unavailable';
    case 'busy':
      return 'busy';
    case 'crashed':
      return starting ? 'init-failed' : 'engine-crashed';
    case 'decode-failed':
    case 'network':
      return 'init-failed';
  }
}

/** The language subtag to hand the engine: the surface's `lang` when the engine knows it. */
export function engineLanguage(lang: string, engine: Pick<DictationEngine, 'languages'>): string | null {
  const code = /^([a-z]{2,3})(?:[-_]|$)/i.exec(lang.trim())?.[1]?.toLowerCase() ?? null;
  if (!code) return null;
  const codes = engine.languages.codes;
  return codes.length === 0 || codes.includes(code) ? code : null;
}

export class EngineRecognition implements RecognitionLike {
  continuous = true;
  interimResults = true;
  /** The surface's language (`fr-FR`); handed to the engine as its subtag when the engine knows it. */
  lang = '';
  onresult: ((event: RecognitionResultEvent) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: RecognitionErrorEvent) => void) | null = null;
  onstart: (() => void) | null = null;

  private phase: Phase = 'idle';
  private run = 0;
  private session: DictationSession | null = null;
  private controller: AbortController | null = null;
  private capture: MicrophoneCapture | null = null;
  private buffered: Float32Array[] = [];
  private bufferedSamples = 0;
  private finals = '';
  private partial = '';
  private stopRequested = false;
  private stopped = false;

  constructor(private readonly deps: EngineRecognitionDeps) {}

  start(): void {
    if (this.phase !== 'idle' && this.phase !== 'ended') {
      throw new Error('InvalidStateError: recognition already started');
    }
    this.run += 1;
    const run = this.run;
    this.phase = 'starting';
    this.session = null;
    const controller = new AbortController();
    this.controller = controller;
    this.capture = null;
    this.buffered = [];
    this.bufferedSamples = 0;
    this.finals = '';
    this.partial = '';
    this.stopRequested = false;
    this.stopped = false;
    void this.boot(run, controller);
  }

  stop(): void {
    if (this.phase === 'starting') {
      this.stopRequested = true;
      return;
    }
    if (this.phase !== 'running') return;
    void this.requestStop(this.run);
  }

  abort(): void {
    if (this.phase === 'idle' || this.phase === 'ended') return;
    this.capture?.stop();
    this.capture = null;
    this.cancelSession();
    // Chromium reports its own abort as an `aborted` error: the voice mode
    // counts on it to clear its "abort was ours" flag.
    const run = this.run;
    setTimeout(() => { if (run === this.run) this.emitError('aborted'); }, 0);
    this.finish(run);
  }

  /** Still the start in progress: not aborted, failed or replaced while it awaited. */
  private booting(run: number): boolean {
    return run === this.run && this.phase === 'starting';
  }

  private async boot(run: number, controller: AbortController): Promise<void> {
    const { engine } = this.deps;
    // Before the engine is even asked how it is: without consent it hears
    // nothing, and no other engine is tried in its place.
    const admission = this.deps.admit?.() ?? 'go';
    if (admission !== 'go') {
      this.fail(run, admission === 'asked' ? 'engine-consent' : admission === 'refused' ? 'engine-not-allowed' : 'engine-undeclared');
      return;
    }
    const availability = await (this.deps.availability ?? readAvailability)(engine).catch(() => null);
    if (!this.booting(run)) return;
    if (availability?.state === 'unavailable') {
      this.fail(run, 'engine-unavailable');
      return;
    }
    // Waiting for its setup: the engine answers the start first (the local
    // one opens its consent card), without the microphone ever being asked
    // for — nor its macOS prompt shown — for a dictation that cannot run.
    // Otherwise the microphone opens before the engine, which may load a
    // model for seconds: the words said meanwhile are buffered, not lost.
    const microphoneFirst = availability?.state !== 'needs-setup';
    if (microphoneFirst && !(await this.openMicrophone(run))) return;
    let session: DictationSession;
    try {
      session = await engine.start({
        language: engineLanguage(this.lang, engine),
        signal: controller.signal,
        onEvent: (event) => this.onEvent(run, event),
      });
    } catch {
      if (this.booting(run)) this.fail(run, 'init-failed');
      return;
    }
    if (!this.booting(run)) {
      // Aborted meanwhile, or failed by its own events: the session is not ours to keep.
      if (run === this.run && !controller.signal.aborted) controller.abort();
      safely(() => session.cancel());
      return;
    }
    this.session = session;
    if (!microphoneFirst && !(await this.openMicrophone(run))) return;
    this.phase = 'running';
    for (const chunk of this.buffered) this.feed(chunk);
    this.buffered = [];
    this.bufferedSamples = 0;
    this.onstart?.();
    if (this.stopRequested) await this.requestStop(run);
  }

  /** False when the start is over (refused, failed, aborted): it said so already. */
  private async openMicrophone(run: number): Promise<boolean> {
    const mic = await this.deps.microphone(true).catch(() => 'unknown' as const);
    if (!this.booting(run)) return false;
    if (mic === 'denied' || mic === 'restricted') {
      this.fail(run, 'microphone-denied');
      return false;
    }
    try {
      const capture = await this.deps.capture({
        onChunk: (samples) => this.onChunk(run, samples),
        onDeviceLost: () => this.onDeviceLost(run),
      });
      if (!this.booting(run)) {
        capture.stop();
        return false;
      }
      this.capture = capture;
      return true;
    } catch (error) {
      if (this.booting(run)) this.fail(run, error instanceof CaptureError ? error.code : 'audio-capture');
      return false;
    }
  }

  /** An engine that throws on a chunk loses that chunk, not the dictation. */
  private feed(samples: Float32Array): void {
    const session = this.session;
    if (session) safely(() => session.feed(samples));
  }

  private cancelSession(): void {
    if (this.controller && !this.controller.signal.aborted) this.controller.abort();
    const session = this.session;
    if (session) safely(() => session.cancel());
  }

  private onChunk(run: number, samples: Float32Array): void {
    if (run !== this.run) return;
    if (this.session && this.phase === 'running') {
      this.feed(samples);
      return;
    }
    if (this.phase !== 'starting') return;
    this.buffered.push(samples);
    this.bufferedSamples += samples.length;
    while (this.bufferedSamples > MAX_BUFFERED_SAMPLES && this.buffered.length > 0) {
      this.bufferedSamples -= this.buffered.shift()!.length;
    }
  }

  private onDeviceLost(run: number): void {
    if (run !== this.run || this.phase === 'ended' || this.phase === 'idle') return;
    this.capture = null;
    // What was already said still comes back as a final before `stopped`.
    if (this.session && this.phase === 'running') {
      this.emitError('microphone-lost');
      void this.stopSession(run);
      return;
    }
    this.fail(run, 'microphone-lost');
  }

  private async requestStop(run: number): Promise<void> {
    if (!this.session || this.phase !== 'running') return;
    const rest = this.capture?.stop() ?? null;
    this.capture = null;
    if (rest && rest.length > 0) this.feed(rest);
    await this.stopSession(run);
  }

  /** Resolves after the session's last final; `stopped` normally ends it first. */
  private async stopSession(run: number): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.phase = 'stopping';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), STOP_DEADLINE_MS); });
    const outcome = await Promise.race([Promise.resolve().then(() => session.stop()).catch(() => {}), late]);
    clearTimeout(timer);
    if (outcome === 'late' && run === this.run) this.cancelSession();
    this.finish(run);
  }

  private onEvent(run: number, raw: unknown): void {
    if (run !== this.run || this.phase === 'ended' || this.phase === 'idle' || this.stopped) return;
    const event = readDictationEvent(raw);
    if (!event) return;
    switch (event.type) {
      case 'partial':
        this.partial = event.text;
        this.emitResults();
        return;
      case 'final':
        this.finals = composerDictee(this.finals, event.text);
        this.partial = '';
        this.emitResults();
        return;
      case 'error':
        // A failed decode loses one utterance; the session goes on.
        if (!event.fatal) return;
        this.fail(run, fatalError(event.code, event.message, this.phase === 'starting'));
        return;
      case 'stopped':
        // Ended by the engine on its own, without an error: like Web Speech
        // ending a turn, the surface decides whether to listen again.
        this.stopped = true;
        this.finish(run);
        return;
    }
  }

  private emitResults(): void {
    const results: Array<{ 0: { transcript: string }; isFinal: boolean }> = [];
    if (this.finals) results.push({ 0: { transcript: this.finals }, isFinal: true });
    if (this.partial.trim()) results.push({ 0: { transcript: this.partial }, isFinal: false });
    this.onresult?.({ resultIndex: 0, results });
  }

  private emitError(error: RecognitionError): void {
    this.onerror?.({ error });
  }

  private fail(run: number, error: Exclude<RecognitionError, 'aborted'>): void {
    this.capture?.stop();
    this.capture = null;
    this.cancelSession();
    this.emitError(error);
    this.finish(run);
  }

  private finish(run: number): void {
    if (run !== this.run || this.phase === 'ended' || this.phase === 'idle') return;
    this.phase = 'ended';
    this.capture?.stop();
    this.capture = null;
    this.session = null;
    // Asynchronous like Web Speech's: a consumer that aborts and replaces its
    // recognizer has already swapped its ref when this lands, and ignores it.
    setTimeout(() => this.onend?.(), 0);
  }
}

function safely(call: () => unknown): void {
  try {
    const result = call();
    if (result instanceof Promise) result.catch(() => {});
  } catch {
    // An engine's own failure on cancel or feed changes nothing for the product.
  }
}
