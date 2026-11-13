/**
 * Contract of a speech-to-text engine (`kind: dictation`, client API 14).
 * A leaf module: the main entry re-exports it, and the test kit
 * (`@rooks/sdk/testing`) reads it without reaching the daemon's tree.
 */

/**
 * Languages a dictation engine recognises (client API 14). `codes` are BCP 47
 * primary subtags (`fr`, `en`). `auto`: the engine detects the language and
 * may ignore the one it is given; `forced`: it uses the one it is given, or
 * detects without; `required`: it cannot start without one.
 */
export type DictationLanguages = {
  readonly codes: readonly string[];
  readonly mode: 'auto' | 'forced' | 'required';
};

/**
 * How early an engine shows provisional text: as the user speaks (`live`),
 * every second or two (`delayed`, an engine fed by blocks), or never before
 * the final text (`final-only`).
 */
export type DictationInterim = 'live' | 'delayed' | 'final-only';

/** Ready, waiting for a setup only the engine's own panel can do (a model to download), or unavailable. */
export type DictationAvailability = {
  state: 'ready' | 'needs-setup' | 'unavailable';
  /** Plain text for the user, never HTML. */
  reason?: string;
};

export type DictationErrorCode = 'unavailable' | 'needs-setup' | 'busy' | 'crashed' | 'decode-failed' | 'network' | 'denied';

/**
 * What an engine reports during a session. `text` is plain text, never HTML,
 * at most 20,000 characters: the product checks every event against this
 * shape and drops one that fails, or that arrives after `stopped`. A `partial`
 * replaces the previous partial; a `final` is appended. `stopped` is always
 * the last event.
 */
export type DictationEvent =
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; code: DictationErrorCode; message: string; fatal: boolean }
  | { type: 'stopped' };

/** What the product hands an engine to start a session. */
export type DictationStartOptions = {
  /** The language the user chose, or `null` for automatic. */
  language: string | null;
  /** Aborted when the product cancels the session; stop feeding work then. */
  signal: AbortSignal;
  onEvent(event: DictationEvent): void;
};

/** One dictation, from `start` to `stop` or `cancel`. */
export type DictationSession = {
  /**
   * PCM, 16 kHz mono, Float32 in [-1, 1], about 100 ms per call (1 sample to
   * 2 s). The product opens the microphone; an engine never does, and only
   * receives samples between `start()` and `stop()` / `cancel()`.
   */
  feed(pcm: Float32Array): void;
  /** Resolves after the last `final`. */
  stop(): Promise<void>;
  /** Drops what is pending; no `final` follows. */
  cancel(): void;
};

/**
 * A speech-to-text engine (`kind: dictation`, client API 14), registered with
 * `ctx.slots.register({ slot: 'dictation.engine', key, dictation: engine }, SettingsPanel)`.
 * The component is the engine's settings panel, shown under the engine in
 * Settings → Interface → Voice dictation, where the user also chooses which
 * engine dictates (Automatic by default). No `settings.voice` graft needed.
 * The product keeps the language choice, the microphone, the session identity
 * and the draft: an engine never sees the composer. Registering needs the
 * permission `dictation:engine`; the manifest's `dictation.engines` says where
 * the voice goes (`egress`), and `id` must be one of its engine ids.
 */
export type DictationEngine = {
  readonly id: string;
  readonly label: string;
  readonly languages: DictationLanguages;
  readonly interim: DictationInterim;
  availability(): Promise<DictationAvailability>;
  start(options: DictationStartOptions): Promise<DictationSession>;
};
