import type { Backend, NormalizedEvent } from '../provider.js';

/** One verdict of the suite: throws (an `AssertionError`) when the provider breaks the contract. */
export type ConformanceCheck = {
  readonly name: string;
  run(): void | Promise<void>;
};

/** Any test runner's `test(name, fn)`: `node:test`, vitest, jest, mocha's `it`. */
export type TestFn = (name: string, fn: () => void | Promise<void>) => unknown;

/** The mission the checks launch. Every field has a default; `cwd` is yours. */
export type ConformanceContext = {
  /** An existing directory, handed to `buildSpawn` as the agent's `cwd`. */
  readonly cwd: string;
  /**
   * Directories the provider writes the system prompt or the message into
   * (a rules file, a prompt file…) instead of argv or stdin. The suite looks
   * for them there; a provider that writes nothing on disk passes none.
   */
  readonly scratchDirs?: readonly string[];
  readonly systemPrompt?: string;
  readonly message?: string;
  readonly missionId?: string;
  /** The session id handed back to `buildSpawn` to check the resume path. */
  readonly resumeId?: string;
  /**
   * Also run `accountUsage` and check the gauge it returns. Off by default: a
   * real probe reaches the network or the user's credentials. Turn it on once
   * your test fakes what the probe talks to.
   */
  readonly checkUsage?: boolean;
};

/** What a recorded session must produce for a line-oriented provider. */
export type LineExpectation = {
  /**
   * The CLI's raw stdout for one turn, one JSON object per line, exactly as it
   * printed it (before any normalization): the text of a `.jsonl` file or its
   * lines. Record it from the real CLI; do not write it by hand from the docs.
   */
  readonly transcript: string | readonly string[];
  /** The session id the transcript's `system:init` must yield. */
  readonly sessionId: string;
  /** The binary `buildSpawn` must launch. */
  readonly cmd: string;
  /** Environment keys `buildSpawn` must set on top of the inherited one. */
  readonly envKeys?: readonly string[];
  /** A model of the provider, handed to `buildSpawn` and expected in argv. */
  readonly model: string;
  /**
   * Where the stream announces its session. `head` (default): the `system:init`
   * opens the flow. `result`: the CLI names its session only in its final line,
   * so the init is emitted right before the `result`.
   */
  readonly initAt?: 'head' | 'result';
};

/**
 * The scenarios a remote provider must survive. `normal` is required; `slow`
 * is a provider whose turns take long enough to cancel or close under, and
 * `failing` one whose session or turn fails. A scenario left out skips its checks.
 */
export type RemoteExpectation = {
  readonly model: string;
  readonly scenarios: {
    readonly normal: Backend;
    readonly slow?: Backend;
    readonly failing?: Backend;
  };
};

export type Emitted = NormalizedEvent;
