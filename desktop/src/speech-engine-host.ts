import { randomUUID } from 'node:crypto';
import type { InterimPolicy } from './speech-segmenter.js';
import { workerOutputSchema, type DictationEvent, type WorkerInit, type WorkerInput } from './speech-protocol.js';

/**
 * Main-process side of the dictation engine: owns the utility process,
 * starts it on the first dictation, keeps it warm for a while (loading the
 * model takes seconds and ~1 GB), and turns its death into an error for the
 * session that was running instead of a silent hang.
 */

/** The slice of Electron's `UtilityProcess` this file uses; a fake in tests. */
export interface EnginePort {
  postMessage(message: WorkerInput): void;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  kill(): boolean;
}

export type EngineHostOptions = {
  /** One process per model: `init` lets it start in the model folder (TODO #484). */
  spawn: (init: WorkerInit) => EnginePort;
  emit: (event: DictationEvent) => void;
  initTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** The process is ended after this long without a session. */
  idleMs?: number;
  log?: (message: string) => void;
};

type Worker = {
  port: EnginePort;
  /** Identifies what the process loaded; a different model needs a new one. */
  key: string;
  ready: Promise<void>;
  alive: boolean;
};

/**
 * What a loaded engine stands for. The language is fixed when the recognizer
 * is created (Canary's `srcLang`, Cohere's `language`): another language, like
 * another model, needs a new process. Entries are sorted so the order an
 * object was built in never splits one engine into two.
 */
export function engineKey(init: WorkerInit): string {
  const sorted = (record: Readonly<Record<string, unknown>>): [string, unknown][] => (
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
  return JSON.stringify([
    init.addonDir, init.modelDir, init.family, sorted(init.files), init.language, sorted(init.options), init.filter, init.numThreads,
  ]);
}

export class EngineError extends Error {
  constructor(readonly code: 'init-failed' | 'engine-crashed', message: string) {
    super(message);
  }
}

export class SpeechEngineHost {
  private readonly options: Required<Omit<EngineHostOptions, 'log'>> & { log: (message: string) => void };
  private worker: Worker | null = null;
  private session: string | null = null;
  private readonly stopWaiters = new Map<string, () => void>();
  private idleTimer: NodeJS.Timeout | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: EngineHostOptions) {
    this.options = {
      initTimeoutMs: 120_000,
      stopTimeoutMs: 30_000,
      idleMs: 5 * 60_000,
      log: (message) => console.warn(message),
      ...options,
    };
  }

  get activeSession(): string | null { return this.session; }

  /** Calls run one after another: two clicks on the mic never start two sessions. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Opens a session, starting the engine for `init` when needed. The previous
   * session is cancelled. The interim policy is per session: changing it never
   * reloads the model.
   */
  start(init: WorkerInit, interim?: InterimPolicy): Promise<string> {
    return this.serial(async () => {
      clearTimeout(this.idleTimer);
      if (this.session) await this.endSession(this.session, 'cancel');
      const worker = await this.ensureWorker(init);
      const sessionId = randomUUID();
      this.session = sessionId;
      worker.port.postMessage(interim ? { type: 'start', sessionId, interim } : { type: 'start', sessionId });
      return sessionId;
    });
  }

  /** Forwards audio of the current session; anything else is dropped. */
  feed(sessionId: string, samples: Float32Array): boolean {
    if (sessionId !== this.session || !this.worker?.alive) return false;
    this.worker.port.postMessage({ type: 'feed', sessionId, samples });
    return true;
  }

  /** Resolves once the last final of the session was emitted. */
  stop(sessionId: string): Promise<void> {
    return this.serial(() => this.endSession(sessionId, 'stop'));
  }

  cancel(sessionId: string): Promise<void> {
    return this.serial(() => this.endSession(sessionId, 'cancel'));
  }

  /** Ends the engine now (quit, or a model about to be deleted). */
  shutdown(): Promise<void> {
    return this.serial(async () => {
      clearTimeout(this.idleTimer);
      if (this.session) await this.endSession(this.session, 'cancel');
      this.kill();
    });
  }

  /** Synchronous end for app quit: no session survives the main process. */
  dispose(): void {
    clearTimeout(this.idleTimer);
    this.kill();
  }

  private async endSession(sessionId: string, how: 'stop' | 'cancel'): Promise<void> {
    if (sessionId !== this.session) return;
    const worker = this.worker;
    if (!worker?.alive) {
      this.finish(sessionId);
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.options.log(`[speech] the engine did not confirm the end of a session within ${this.options.stopTimeoutMs} ms`);
        this.kill();
        this.finish(sessionId);
        resolve();
      }, this.options.stopTimeoutMs);
      this.stopWaiters.set(sessionId, () => { clearTimeout(timer); resolve(); });
      worker.port.postMessage({ type: how, sessionId });
    });
  }

  /** Closes the session on this side: `stopped` to the renderer, idle timer armed. */
  private finish(sessionId: string): void {
    if (this.session === sessionId) this.session = null;
    this.options.emit({ type: 'stopped', sessionId });
    const waiter = this.stopWaiters.get(sessionId);
    this.stopWaiters.delete(sessionId);
    waiter?.();
    if (!this.session) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { if (!this.session) this.kill(); }, this.options.idleMs);
      this.idleTimer.unref?.();
    }
  }

  private kill(): void {
    const worker = this.worker;
    this.worker = null;
    if (worker?.alive) {
      worker.alive = false;
      worker.port.kill();
    }
  }

  private async ensureWorker(init: WorkerInit): Promise<Worker> {
    const key = engineKey(init);
    if (this.worker?.alive && this.worker.key !== key) this.kill();
    if (!this.worker?.alive) this.worker = this.launch(init, key);
    const worker = this.worker;
    try {
      await worker.ready;
    } catch (error) {
      if (this.worker === worker) this.kill();
      throw error;
    }
    return worker;
  }

  private launch(init: WorkerInit, key: string): Worker {
    const port = this.options.spawn(init);
    let settle: { resolve: () => void; reject: (error: Error) => void } | null = null;
    const ready = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    // A rejection nobody awaits yet must not crash the main process.
    ready.catch(() => undefined);
    const worker: Worker = { port, key, ready, alive: true };
    const timer = setTimeout(() => {
      settle?.reject(new EngineError('init-failed', 'The dictation engine took too long to load its model.'));
      settle = null;
    }, this.options.initTimeoutMs);

    port.on('message', (raw) => {
      const parsed = workerOutputSchema.safeParse(raw);
      if (!parsed.success) return;
      const message = parsed.data;
      switch (message.type) {
        case 'ready':
          clearTimeout(timer);
          settle?.resolve();
          settle = null;
          return;
        case 'init-failed':
          clearTimeout(timer);
          this.options.log(`[speech] the engine could not load the model: ${message.message}`);
          settle?.reject(new EngineError('init-failed', 'The dictation engine could not load the speech model.'));
          settle = null;
          return;
        case 'stopped':
          this.finish(message.sessionId);
          return;
        default:
          // Late output of a session already closed here is dropped.
          if (message.sessionId === this.session) this.options.emit(message);
      }
    });

    port.on('exit', (code) => {
      clearTimeout(timer);
      worker.alive = false;
      if (this.worker === worker) this.worker = null;
      settle?.reject(new EngineError('engine-crashed', `The dictation engine exited (code ${code}) while loading.`));
      settle = null;
      const sessionId = this.session;
      if (sessionId) {
        this.options.log(`[speech] the engine exited with code ${code} during a session`);
        this.options.emit({ type: 'error', sessionId, code: 'engine-crashed', message: 'The dictation engine stopped unexpectedly.' });
        this.finish(sessionId);
      }
      for (const [id, waiter] of this.stopWaiters) {
        this.stopWaiters.delete(id);
        waiter();
      }
    });
    port.postMessage(init);
    return worker;
  }
}
