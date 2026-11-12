/**
 * The session driver: one Rooks mission ⇄ one Hermes session, one turn ⇄ one
 * Hermes run (`POST /v1/runs`).
 *
 * The way a run is followed is ported from the Hermes Web UI gateway client
 * (api/gateway_chat.py, MIT, see NOTICE):
 *  - the run is submitted with an `Idempotency-Key`, reused on every retry of
 *    the same message, so a lost answer to the POST never starts it twice;
 *  - its `run_id` is kept (and saved for a daemon restart) as soon as known;
 *  - the event stream has a watchdog: a keepalive proves the socket alive, not
 *    the run progressing — after `watchdogMs` without an event the run status
 *    is asked;
 *  - `GET /v1/runs/{id}` decides how a turn ended whenever the stream did not
 *    say it (cut, gone, stalled);
 *  - approvals are deduplicated by request id and dropped once the run ended.
 *
 * Two stream modes, decided on the first frame because no capability flag
 * announces them: `replay` (Hermes 0.21.6+, frames carry `id:` and a cut
 * stream resumes with `Last-Event-ID`) and `degraded` (0.21.0–0.21.5, one
 * reader only, a reconnection answers 404): once its stream is lost, a
 * degraded turn polls the run status until it ends and takes the final answer
 * from it.
 */
import { randomUUID } from 'node:crypto';
import type {
  ImageAttachment, NormalizedEvent, PermissionRequest, RemoteDialect, RemoteSessionOpenArgs, RemoteSessionResume,
  SessionCapabilities, SessionDriver, SessionInfo, TurnOutcome,
} from '@rooks/sdk';
import { UserFacingError } from './connection.js';
import { TurnMapper, parseEvent, type HermesEvent, type TurnEnd } from './events.js';
import {
  call, GatewayError, GatewayUnreachableError, headers, joinUrl, missingFeatures, send, versionTooOld,
  type Fetch, type GatewayTarget,
} from './gateway.js';
import { readSse } from './sse.js';

export const DIALECT_ID = 'hermes-gateway';
/** The backend agents name: one profile on the dialect, same id. */
export const PROFILE_ID = 'hermes-gateway';

export type Timing = {
  /** No event for this long (keepalives do not count): ask the run status. */
  readonly watchdogMs: number;
  /** Not even a keepalive for this long: the socket is dead (Hermes sends one every 10 s, 30 s before 0.21.6). */
  readonly deadSocketMs: number;
  readonly tickMs: number;
  /** Pace of status polls and of stream reconnections. */
  readonly pollMs: number;
  /** How long a gateway may stay unreachable under a running turn (a gateway restart drains for 30 s). */
  readonly unreachableBudgetMs: number;
  /** Attempts of `POST /v1/runs` on a network failure or a 5xx. */
  readonly admitAttempts: number;
  /** How long a message waits for a free slot when the gateway answers 429. */
  readonly rateLimitBudgetMs: number;
  /** After STOP, how long the gateway has to confirm before the turn ends anyway. */
  readonly cancelGraceMs: number;
  /** Resume state saved at most this often while text streams. */
  readonly saveThrottleMs: number;
};

export const DEFAULT_TIMING: Timing = {
  watchdogMs: 120_000,
  deadSocketMs: 75_000,
  tickMs: 1_000,
  pollMs: 2_000,
  unreachableBudgetMs: 180_000,
  admitAttempts: 5,
  rateLimitBudgetMs: 120_000,
  cancelGraceMs: 15_000,
  saveThrottleMs: 500,
};

export type DriverLog = { info(message: string): void; warn(message: string): void };

export type DriverDeps = {
  readonly fetch: Fetch;
  /** The gateway of the account behind this launch, for the agent's model. */
  resolveTarget(launch: RemoteSessionOpenArgs['launch'], model: string | null): Promise<GatewayTarget>;
  readonly log?: DriverLog;
  readonly timing?: Partial<Timing>;
};

/** What a Hermes session does, settled by measure: it reopens by id with its
 *  transcript, takes no MCP server from Rooks, and images were never measured. */
const CAPABILITIES: SessionCapabilities = Object.freeze({ loadSession: false, resume: true, mcp: false, image: false });

const INTERRUPTED = 'The Hermes gateway restarted and interrupted this answer. The conversation is kept: send your message again to continue.';
const LOST_ADMISSION = 'Rooks restarted while your message was being sent to Hermes, and cannot tell whether it arrived. Send it again.';
const RUN_GONE = 'The Hermes gateway no longer knows the run of this answer (it expired, or the gateway lost it). Send your message again.';

type Turn = {
  runId: string | null;
  readonly idempotencyKey: string;
  readonly mapper: TurnMapper;
  lastSeq: number;
  settle: { resolve(outcome: TurnOutcome): void; reject(error: Error): void } | null;
  /** Aborts the turn's own requests (stream, polls). */
  readonly abort: AbortController;
  /** Wakes a waiting retry, so a STOP is seen at once. */
  wake: AbortController;
  cancelRequested: boolean;
  done: boolean;
  /** The stream of this run cannot be read again (degraded mode). */
  streamGone: boolean;
  /** Request ids already put to the user (or answered elsewhere). */
  readonly approvals: Set<string>;
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The message of an error a user may read; anything unexpected stays generic. */
export function readable(err: unknown): string {
  if (err instanceof UserFacingError || err instanceof GatewayError || err instanceof GatewayUnreachableError) return err.message;
  return 'The Hermes gateway session failed.';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function hermesError(value: unknown): string {
  const text = typeof value === 'string' ? value : str(record(value)?.message);
  const flat = text?.replace(/\s+/g, ' ').trim();
  return flat ? `The Hermes run failed: ${flat.length > 300 ? `${flat.slice(0, 300)}…` : flat}` : 'The Hermes run failed.';
}

export function initEvent(sessionId: string, backend: string, model: string | null): NormalizedEvent {
  return {
    type: 'system',
    payload: { type: 'system', subtype: 'init', session_id: sessionId, backend, ...(model ? { model } : {}), mcp_servers: [], tools: [] },
  };
}

export function extractSessionId(ev: NormalizedEvent): string | null {
  if (ev.type !== 'system') return null;
  const payload = record(ev.payload);
  if (!payload || payload.subtype !== 'init') return null;
  return str(payload.session_id);
}

export class HermesDriver implements SessionDriver {
  private readonly timing: Timing;
  private target: GatewayTarget | null = null;
  private sessionId: string | null = null;
  private current: SessionInfo | null = null;
  private closed = false;
  private turn: Turn | null = null;
  /** Decided on the first frame of the first stream, then kept. */
  private mode: 'unknown' | 'replay' | 'degraded' = 'unknown';
  private lastSave = 0;

  constructor(private readonly args: RemoteSessionOpenArgs, private readonly deps: DriverDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
  }

  get info(): SessionInfo | null {
    return this.current;
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  async start(): Promise<SessionInfo> {
    if (this.closed) throw new Error('the session is closed');
    if (this.current) return this.current;
    const model = this.args.spawn.cfg.model ?? null;
    let target: GatewayTarget;
    try {
      target = await this.deps.resolveTarget(this.args.launch, model);
      const { body } = await call(this.deps.fetch, target, 'GET', 'v1/capabilities');
      const missing = missingFeatures(body);
      if (missing.length > 0) throw new UserFacingError(versionTooOld(missing));
    } catch (err) {
      throw new Error(readable(err));
    }
    if (this.closed) throw new Error('the session is closed');
    this.target = target;
    if (this.args.resume) return this.reattach(this.args.resume);

    const asked = this.args.spawn.resumeSession;
    const sessionId = asked ?? `rooks-${randomUUID()}`;
    const resumed = asked ? await this.sessionKnown(asked) : false;
    if (this.closed) throw new Error('the session is closed');
    this.sessionId = sessionId;
    this.current = { sessionId, capabilities: CAPABILITIES, resumed };
    this.emit(initEvent(sessionId, this.args.profileId, model));
    // From here a restarted daemon finds the session again, even mid-turn.
    this.save(true);
    return this.current;
  }

  prompt(text: string, images?: ImageAttachment[]): Promise<TurnOutcome> {
    if (this.closed) return Promise.reject(new Error('the session is closed'));
    if (!this.current || !this.target) return Promise.reject(new Error('the session is not started'));
    if (this.turn && !this.turn.done) return Promise.reject(new Error('a turn is already running'));
    return new Promise<TurnOutcome>((resolve, reject) => {
      const turn = this.newTurn(null, -1);
      turn.settle = { resolve, reject };
      this.turn = turn;
      if (images && images.length > 0) {
        this.emit({
          type: 'assistant',
          payload: { type: 'assistant', message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: `(${images.length} image(s) not sent: a Hermes gateway agent receives text only.)` }] } },
        });
      }
      void this.runTurn(turn, text);
    });
  }

  /** `POST /v1/runs/{id}/steer`: the instruction reaches the run that is going on. */
  async steer(text: string): Promise<boolean> {
    const turn = this.turn;
    if (!turn || turn.done || !turn.runId || !this.target || this.closed) return false;
    try {
      await call(this.deps.fetch, this.target, 'POST', `v1/runs/${encodeURIComponent(turn.runId)}/steer`, { body: { input: text } });
      return true;
    } catch (err) {
      // 409: the run is not running any more (finishing, or waiting on an
      // approval) — there is nothing to redirect.
      if (err instanceof GatewayError && err.status === 409) return false;
      throw err;
    }
  }

  async cancel(): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.done) return;
    turn.cancelRequested = true;
    turn.wake.abort();
    // The gateway confirms with `run.cancelled`; if it never does, the turn
    // still ends, so STOP is never a dead button.
    const grace = setTimeout(() => {
      if (!turn.done) this.finishTurn(turn, { kind: 'cancelled' });
    }, this.timing.cancelGraceMs);
    grace.unref?.();
    if (turn.runId) await this.stopRun(turn.runId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const turn = this.turn;
    if (!turn || turn.done) return;
    turn.done = true;
    turn.abort.abort();
    turn.wake.abort();
    // A close is a stop: the run must not go on with nobody to read it. A
    // daemon that dies closes nothing, which leaves the run for the next one.
    if (turn.runId) void this.stopRun(turn.runId);
    const settle = turn.settle;
    turn.settle = null;
    settle?.reject(new Error('the session was closed'));
  }

  /* ── After a daemon restart ───────────────────────────────────────────── */

  private async reattach(resume: RemoteSessionResume): Promise<SessionInfo> {
    const state = resume.state;
    const sessionId = str(state.sessionId);
    if (!sessionId) throw new Error('The saved position of this Hermes conversation is unreadable.');
    const runId = str(state.runId);
    const lastSeq = typeof state.lastSeq === 'number' && Number.isInteger(state.lastSeq) ? state.lastSeq : -1;
    this.sessionId = sessionId;
    this.current = { sessionId, capabilities: CAPABILITIES, resumed: true };
    if (!resume.turnActive) {
      this.save(true);
      return this.current;
    }
    const turn = this.newTurn(runId, lastSeq);
    this.turn = turn;
    if (!runId) {
      this.finishTurn(turn, { kind: 'failed', message: LOST_ADMISSION });
      return this.current;
    }
    let status: Record<string, unknown>;
    try {
      status = (await call(this.deps.fetch, this.target!, 'GET', `v1/runs/${encodeURIComponent(runId)}`)).body;
    } catch (err) {
      turn.done = true;
      if (err instanceof GatewayError && err.status === 404) throw new Error(RUN_GONE);
      throw new Error(readable(err));
    }
    // Followed in the background: start() returns, the runner waits for the result.
    void this.follow(turn, status).catch((err: unknown) => this.finishTurn(turn, { kind: 'failed', message: readable(err) }));
    return this.current;
  }

  /* ── One turn ─────────────────────────────────────────────────────────── */

  private newTurn(runId: string | null, lastSeq: number): Turn {
    return {
      runId,
      idempotencyKey: `rooks-${randomUUID()}`,
      mapper: new TurnMapper(`hermes-${randomUUID().slice(0, 8)}`),
      lastSeq,
      settle: null,
      abort: new AbortController(),
      wake: new AbortController(),
      cancelRequested: false,
      done: false,
      streamGone: false,
      approvals: new Set(),
    };
  }

  private async runTurn(turn: Turn, text: string): Promise<void> {
    try {
      const runId = await this.admit(turn, text);
      if (runId === null || turn.done) return;
      await this.follow(turn, null);
    } catch (err) {
      if (turn.done) return;
      turn.done = true;
      turn.abort.abort();
      const settle = turn.settle;
      turn.settle = null;
      settle?.reject(new Error(readable(err)));
    }
  }

  /** `POST /v1/runs`, retried with the same key. Null when the turn ended here. */
  private async admit(turn: Turn, text: string): Promise<string | null> {
    const target = this.target!;
    const systemPrompt = this.args.spawn.systemPrompt;
    const body = { input: text, session_id: this.sessionId, ...(systemPrompt ? { instructions: systemPrompt } : {}) };
    const started = Date.now();
    let attempt = 0;
    for (;;) {
      if (turn.done) return null;
      if (turn.cancelRequested) {
        this.finishTurn(turn, { kind: 'cancelled' });
        return null;
      }
      try {
        const { body: answer } = await call(this.deps.fetch, target, 'POST', 'v1/runs', {
          body, signal: turn.abort.signal, extraHeaders: { 'idempotency-key': turn.idempotencyKey },
        });
        const runId = str(answer.run_id);
        if (!runId) throw new GatewayError('The Hermes gateway accepted the message without naming its run.', 502, null);
        if (turn.done) {
          void this.stopRun(runId);
          return null;
        }
        turn.runId = runId;
        this.save(true);
        if (turn.cancelRequested) await this.stopRun(runId);
        return runId;
      } catch (err) {
        if (turn.done || turn.abort.signal.aborted) return null;
        if (err instanceof GatewayError && err.status === 429) {
          if (Date.now() - started >= this.timing.rateLimitBudgetMs) {
            this.finishTurn(turn, { kind: 'failed', message: err.message });
            return null;
          }
          turn.wake = new AbortController();
          await sleep(err.retryAfterMs ?? 1_000, turn.wake.signal);
          continue;
        }
        const transient = err instanceof GatewayUnreachableError || (err instanceof GatewayError && err.status >= 500);
        if (transient && ++attempt < this.timing.admitAttempts) {
          turn.wake = new AbortController();
          await sleep(Math.min(this.timing.pollMs * 2 ** (attempt - 1), 30_000), turn.wake.signal);
          continue;
        }
        // An answer the gateway refused ends the turn, the conversation goes
        // on; a gateway nobody can reach fails the mission.
        if (err instanceof GatewayError) {
          this.finishTurn(turn, { kind: 'failed', message: err.message });
          return null;
        }
        throw err;
      }
    }
  }

  /** Reads the run to its end: stream first, status when the stream fails. */
  private async follow(turn: Turn, initial: Record<string, unknown> | null): Promise<void> {
    if (initial && await this.settleFromStatus(turn, initial)) return;
    let unreachableSince: number | null = null;
    let notFound = 0;
    while (!turn.done && !this.closed) {
      if (!turn.streamGone) {
        const outcome = await this.stream(turn);
        if (turn.done || this.closed) return;
        // Only a replayable stream is worth opening again.
        if (outcome !== 'unreachable' && this.mode !== 'replay') turn.streamGone = true;
      }
      try {
        const { body } = await call(this.deps.fetch, this.target!, 'GET', `v1/runs/${encodeURIComponent(turn.runId!)}`, { signal: turn.abort.signal });
        unreachableSince = null;
        notFound = 0;
        if (await this.settleFromStatus(turn, body)) return;
      } catch (err) {
        if (turn.done || turn.abort.signal.aborted) return;
        if (err instanceof GatewayError && err.status === 404) {
          // One grace probe: a status asked a hair before the run is registered.
          if (++notFound >= 2) { this.finishTurn(turn, { kind: 'failed', message: RUN_GONE }); return; }
          continue;
        }
        if (err instanceof GatewayError && (err.status === 401 || err.status === 403)) {
          this.finishTurn(turn, { kind: 'failed', message: err.message });
          return;
        }
        unreachableSince ??= Date.now();
        if (Date.now() - unreachableSince >= this.timing.unreachableBudgetMs) {
          throw new GatewayUnreachableError('Rooks lost contact with the Hermes gateway during this answer. Hermes keeps the conversation: send a message to continue once it is back.');
        }
      }
      await sleep(this.timing.pollMs, turn.abort.signal);
    }
  }

  /** One read of the event stream. Never throws. */
  private async stream(turn: Turn): Promise<'terminal' | 'eof' | 'gone' | 'unreachable' | 'aborted'> {
    const target = this.target!;
    const controller = new AbortController();
    const relay = (): void => controller.abort();
    turn.abort.signal.addEventListener('abort', relay, { once: true });
    const resumeFrom: Record<string, string> = this.mode === 'replay' && turn.lastSeq >= 0 ? { 'last-event-id': String(turn.lastSeq) } : {};
    let timer: ReturnType<typeof setInterval> | null = null;
    try {
      let response: Response;
      try {
        response = await send(this.deps.fetch, joinUrl(target.base, `v1/runs/${encodeURIComponent(turn.runId!)}/events`), {
          method: 'GET',
          headers: headers(target, { accept: 'text/event-stream', 'accept-encoding': 'identity', ...resumeFrom }),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch {
        return controller.signal.aborted ? 'aborted' : 'unreachable';
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 404) return 'gone';
        return 'unreachable';
      }
      let lastByte = Date.now();
      let lastEvent = Date.now();
      timer = setInterval(() => {
        const now = Date.now();
        if (now - lastByte >= this.timing.deadSocketMs) controller.abort();
        else if (now - lastEvent >= this.timing.watchdogMs) {
          lastEvent = now;
          void this.watchdog(turn, controller);
        }
      }, this.timing.tickMs);
      timer.unref?.();
      for await (const frame of readSse(response.body)) {
        lastByte = Date.now();
        if (frame.kind === 'comment') continue;
        if (this.mode === 'unknown') this.mode = frame.id !== null ? 'replay' : 'degraded';
        const ev = parseEvent(frame.data);
        if (!ev) continue;
        const seq = frame.id !== null && /^\d+$/.test(frame.id) ? Number(frame.id) : null;
        if (seq !== null && seq <= turn.lastSeq) continue;
        lastEvent = Date.now();
        this.handle(turn, ev);
        if (turn.done) return 'terminal';
        if (seq !== null) turn.lastSeq = seq;
        this.save(ev.event !== 'message.delta');
      }
      return 'eof';
    } catch {
      return controller.signal.aborted ? 'aborted' : 'unreachable';
    } finally {
      if (timer) clearInterval(timer);
      turn.abort.signal.removeEventListener('abort', relay);
      controller.abort();
    }
  }

  /** The stream went quiet: the status says whether the run is still on. */
  private async watchdog(turn: Turn, stream: AbortController): Promise<void> {
    try {
      const { body } = await call(this.deps.fetch, this.target!, 'GET', `v1/runs/${encodeURIComponent(turn.runId!)}`, { signal: turn.abort.signal });
      if (await this.settleFromStatus(turn, body)) stream.abort();
    } catch {
      // The stream itself, or the next arbitration, will tell.
    }
  }

  private handle(turn: Turn, ev: HermesEvent): void {
    switch (ev.event) {
      case 'approval.request':
        void this.approval(turn, ev);
        return;
      case 'approval.responded': {
        const id = str(ev.request_id);
        if (id) turn.approvals.add(id);
        return;
      }
      case 'run.completed':
        this.finishTurn(turn, { kind: 'completed', output: str(ev.output), usage: ev.usage });
        return;
      case 'run.cancelled':
        this.finishTurn(turn, { kind: 'cancelled' });
        return;
      case 'run.failed':
        this.finishTurn(turn, { kind: 'failed', message: hermesError(ev.error) });
        return;
      case 'run.interrupted':
        void this.interrupted(turn);
        return;
      default:
        this.emitAll(turn.mapper.map(ev));
    }
  }

  /** True when the status ends the turn. */
  private async settleFromStatus(turn: Turn, status: Record<string, unknown>): Promise<boolean> {
    if (turn.done) return true;
    switch (str(status.status)) {
      case 'completed':
        this.finishTurn(turn, { kind: 'completed', output: str(status.output), usage: status.usage });
        return true;
      case 'cancelled':
        this.finishTurn(turn, { kind: 'cancelled' });
        return true;
      case 'failed':
        this.finishTurn(turn, { kind: 'failed', message: hermesError(status.error) });
        return true;
      case 'interrupted':
        await this.interrupted(turn);
        return true;
      case 'waiting_for_approval': {
        // The card may have been lost with the stream, or with a daemon restart.
        const approval = record(status.approval);
        if (approval) void this.approval(turn, approval);
        return false;
      }
      default:
        if (status.shutdown_requested_at) this.deps.log?.info('hermes gateway is shutting down under a running turn');
        return false;
    }
  }

  private async interrupted(turn: Turn): Promise<void> {
    if (turn.done) return;
    const partial = await this.partialText();
    this.finishTurn(turn, { kind: 'interrupted', message: INTERRUPTED, partial });
  }

  /** What Hermes kept of an interrupted answer: the assistant messages after
   *  the last user message of the session. */
  private async partialText(): Promise<string | null> {
    if (!this.target || !this.sessionId) return null;
    try {
      const { body } = await call(this.deps.fetch, this.target, 'GET', `api/sessions/${encodeURIComponent(this.sessionId)}/messages`);
      const list = [body.messages, body.data, body.items].find(Array.isArray) as unknown[] | undefined;
      if (!list) return null;
      let lastUser = -1;
      list.forEach((m, i) => { if (record(m)?.role === 'user') lastUser = i; });
      const texts = list.slice(lastUser + 1)
        .map(record)
        .filter((m): m is Record<string, unknown> => m?.role === 'assistant')
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .filter((t) => t.trim());
      return texts.length > 0 ? texts.join('\n\n') : null;
    } catch {
      return null;
    }
  }

  /** `approval.request` → the product's Allow/Deny card → `once` or `deny`. */
  private async approval(turn: Turn, payload: Record<string, unknown>): Promise<void> {
    const id = str(payload.request_id);
    if (!id || turn.approvals.has(id) || turn.done || this.closed) return;
    turn.approvals.add(id);
    const command = str(payload.command);
    const description = str(payload.description);
    const request: PermissionRequest = {
      toolCallId: id,
      tool: turn.mapper.lastTool ?? 'terminal',
      title: description ?? command,
      input: {
        ...(command ? { command } : {}),
        ...(description ? { description } : {}),
        ...(Array.isArray(payload.pattern_keys) ? { pattern_keys: payload.pattern_keys } : {}),
      },
      // Hermes remembers a choice for the session or for good: the card offers both.
      scopes: ['session', 'always'],
    };
    let allow = false;
    let scope: 'session' | 'always' | undefined;
    try {
      const decision = await this.args.host.requestPermission(request);
      allow = decision.allow;
      scope = decision.scope;
    } catch {
      allow = false;
    }
    // Settled with the run: an answer that comes after its end is dropped.
    if (turn.done || this.closed || !turn.runId) return;
    try {
      await call(this.deps.fetch, this.target!, 'POST', `v1/runs/${encodeURIComponent(turn.runId)}/approval`, {
        body: { choice: allow ? scope ?? 'once' : 'deny', request_id: id },
      });
    } catch (err) {
      // 409: already answered, or the run ended meanwhile.
      if (!(err instanceof GatewayError && err.status === 409)) this.deps.log?.warn(`hermes approval answer failed: ${readable(err)}`);
    }
  }

  private async stopRun(runId: string): Promise<void> {
    if (!this.target) return;
    try {
      await call(this.deps.fetch, this.target, 'POST', `v1/runs/${encodeURIComponent(runId)}/stop`);
    } catch (err) {
      this.deps.log?.warn(`hermes stop failed: ${readable(err)}`);
    }
  }

  /** Does Hermes still hold this session? Unknown counts as yes. */
  private async sessionKnown(sessionId: string): Promise<boolean> {
    try {
      await call(this.deps.fetch, this.target!, 'GET', `api/sessions/${encodeURIComponent(sessionId)}`);
      return true;
    } catch (err) {
      return !(err instanceof GatewayError && err.status === 404);
    }
  }

  private finishTurn(turn: Turn, end: TurnEnd): void {
    if (turn.done) return;
    turn.done = true;
    this.emitAll(turn.mapper.finish(end));
    turn.abort.abort();
    turn.wake.abort();
    turn.runId = null;
    turn.lastSeq = -1;
    this.save(true);
    const settle = turn.settle;
    turn.settle = null;
    const stopReason = end.kind === 'completed' ? 'end_turn' : end.kind === 'cancelled' ? 'cancelled' : end.kind === 'interrupted' ? 'interrupted' : 'error';
    settle?.resolve({ stopReason });
  }

  /* ── Out ──────────────────────────────────────────────────────────────── */

  private emit(ev: NormalizedEvent): void {
    if (!this.closed) this.args.host.emit(ev);
  }

  private emitAll(events: readonly NormalizedEvent[]): void {
    for (const ev of events) this.emit(ev);
  }

  /** `{ runId, sessionId, lastSeq }` and nothing else: never the key, never the URL. */
  private save(force: boolean): void {
    if (this.closed || !this.sessionId) return;
    const now = Date.now();
    if (!force && now - this.lastSave < this.timing.saveThrottleMs) return;
    this.lastSave = now;
    const turn = this.turn && !this.turn.done ? this.turn : null;
    try {
      this.args.host.saveResume({ runId: turn?.runId ?? null, sessionId: this.sessionId, lastSeq: turn?.lastSeq ?? -1 });
    } catch (err) {
      this.deps.log?.warn(`hermes resume state refused: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
}

/** The remote dialect: no process, the driver above is the whole session. */
export function createHermesDialect(deps: DriverDeps): RemoteDialect {
  return {
    id: DIALECT_ID,
    transport: 'remote',
    sessionResumable: true,
    sessionStore: 'global',
    permissionModel: 'protocol',
    rateLimitReporting: 'none',
    hostedConnectors: false,
    // The agent works on the gateway's machine (no Rooks folder), takes its
    // MCP servers from its own config.yaml, and /v1/runs drops files silently.
    capabilities: { worktree: false, novaMcp: false, attachments: false, novaPreamble: false },
    openSession: (args) => new HermesDriver(args, deps),
    extractSessionId,
  };
}
