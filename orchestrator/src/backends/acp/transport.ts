/**
 * Agent Client Protocol transport: JSON-RPC 2.0 over an agent's stdio, TIMON
 * being the CLIENT.
 *
 * This layer knows the wire and nothing else. It owns request/response
 * correlation, the requests the AGENT sends us (permission asks, and the
 * `fs/*` / `terminal/*` it may not use), timeouts and the process's death. It
 * knows nothing about opencode or Hermes and never maps a vendor's quirks:
 * that is the dialect's job, one level up (cf. `SessionDriver`).
 *
 * Two ways in, one class:
 *   - `AcpTransport.spawn(...)` starts the agent itself (probes, tools);
 *   - `new AcpTransport({ io })` speaks over pipes somebody else owns — the
 *     runner's process, or a `PassThrough` pair in a test. `stop()` then only
 *     lets go: killing that process is not this class's business.
 *
 * Wire facts, all observed on opencode 1.18.33 and hermes-agent 0.21.0:
 * newline-delimited JSON, one message per line; a turn ends with the reply to
 * OUR `session/prompt` (`stopReason` + `usage`), never with a notification;
 * `session/cancel` is a notification whose effect is a `cancelled` reply to
 * the pending prompt.
 *
 * Hardening, because the peer is a third-party program: a line that is not
 * JSON is dropped and counted, never thrown; one message cannot grow the
 * buffer without bound; a callback that throws cannot kill the read loop;
 * pending requests can never outlive the process.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { redactText } from '../../secrets/redact.js';
import {
  RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND, type AcpMcpServer, type AcpRecord, type AcpUsage,
} from './wire.js';

export { RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND };
export type { AcpMcpServer, AcpRecord, AcpUsage };

/* ── Errors ─────────────────────────────────────────────────────────────── */

export type AcpTransportErrorKind =
  /** The process could not start. */
  | 'spawn'
  /** The process exited or its stdout ended. */
  | 'exited'
  /** We stopped the transport ourselves. */
  | 'closed'
  /** No reply within the request's time budget. */
  | 'timeout'
  /** The agent answered something the protocol does not allow. */
  | 'protocol';

export class AcpTransportError extends Error {
  constructor(readonly kind: AcpTransportErrorKind, message: string) {
    super(message);
    this.name = 'AcpTransportError';
  }
}

/** The agent answered a request with a JSON-RPC error object. */
export class AcpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'AcpRpcError';
  }
}


/* ── Protocol shapes (only what the client reads or writes) ─────────────── */


export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | ({ type: string } & AcpRecord);



export type AcpPromptResult = {
  /** The agent's own word (`end_turn`, `cancelled`, `max_tokens`, …). */
  stopReason: string;
  usage: AcpUsage | null;
};

export type AcpPermissionOption = {
  optionId: string;
  name: string;
  /** `allow_once`, `allow_always`, `reject_once`, `reject_always` — left open. */
  kind: string;
};

export type AcpPermissionRequest = {
  sessionId: string;
  /** The `toolCall` object as sent: `toolCallId`, `title`, `kind`, `rawInput`… */
  toolCall: AcpRecord;
  options: AcpPermissionOption[];
};

export type AcpPermissionResponse =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

/** `signal` aborts when the turn is cancelled or the transport dies: a handler
 *  waiting on a human should stop waiting. Whatever it returns after that is
 *  discarded, the agent has been answered already. */
export type AcpPermissionHandler = (
  req: AcpPermissionRequest,
  signal: AbortSignal,
) => Promise<AcpPermissionResponse>;

/** Cf. `AcpTransportOptions.onExtensionRequest`. */
export type AcpExtensionRequestHandler = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;

/* ── Options ────────────────────────────────────────────────────────────── */

export type AcpSpawnFn = (name: string, args: string[], opts: SpawnOptions) => ChildProcess;

export type AcpCloseInfo = {
  /** Why the transport stopped being usable. */
  reason: 'exited' | 'closed' | 'error';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export type AcpTransportOptions = {
  io: { stdin: Writable; stdout: Readable };
  /** Every `session/update` notification, params as sent. */
  onSessionUpdate?: (params: AcpRecord) => void;
  /** Answers `session/request_permission`. Absent, throwing or rejecting =
   *  `cancelled`: an agent is never left hanging on us. */
  onPermissionRequest?: AcpPermissionHandler;
  /** Requests of the agent's own the provider handles (`AcpAgentSpec.extensionRequests`): any other
   *  method still gets "method not found". */
  extensionMethods?: ReadonlySet<string>;
  /** Answers one of `extensionMethods`: the value is the `result`, a throw a generic error. `signal`
   *  aborts when the turn is cancelled or the transport dies. */
  onExtensionRequest?: AcpExtensionRequestHandler;
  /** Default budget of a request, ms. Default 30 000. */
  requestTimeoutMs?: number;
  /** Budget of `session/prompt`, ms. Default none: a turn legitimately runs for
   *  minutes, and the runner has its own hung-turn watchdog. */
  promptTimeoutMs?: number;
  /** One message larger than this is dropped. Default 16 MiB. */
  maxLineBytes?: number;
  /** Version reported in `clientInfo` by `initialize`. */
  clientVersion?: string;
};

export type AcpSpawnOptions = Omit<AcpTransportOptions, 'io'> & {
  command: string;
  args?: string[];
  cwd: string;
  /** The COMPLETE environment, passed verbatim (the host adapter's contract). */
  env?: NodeJS.ProcessEnv;
  /** How the process starts: the daemon's host adapter in production (see
   *  `host-transport.ts`), anything in a test. Required, so this module reaches
   *  nothing of the daemon and can be handed to a provider plugin as it is. */
  spawn: AcpSpawnFn;
  /** SIGTERM → SIGKILL delay of `stop()`, ms. Default 3 000. */
  killGraceMs?: number;
  /** How much stderr is kept, bytes (the tail). Default 8 KiB. */
  stderrMaxBytes?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 3_000;
const DEFAULT_STDERR_MAX_BYTES = 8 * 1024;
/** After the process exits (or stdout ends), how long to wait for the other
 *  half so a reply written just before the exit is not lost. */
const CLOSE_SETTLE_MS = 250;
const PROTOCOL_VERSION = 1;

/* ── Small readers ──────────────────────────────────────────────────────── */

function asRecord(v: unknown): AcpRecord | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as AcpRecord) : null;
}

function nonNegInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function parseUsage(v: unknown): AcpUsage | null {
  const u = asRecord(v);
  if (!u) return null;
  return {
    inputTokens: nonNegInt(u.inputTokens),
    outputTokens: nonNegInt(u.outputTokens),
    thoughtTokens: nonNegInt(u.thoughtTokens),
    cachedReadTokens: nonNegInt(u.cachedReadTokens),
  };
}

function parsePermissionRequest(params: unknown): AcpPermissionRequest | null {
  const p = asRecord(params);
  if (!p || typeof p.sessionId !== 'string') return null;
  const toolCall = asRecord(p.toolCall) ?? {};
  if (!Array.isArray(p.options)) return null;
  const options: AcpPermissionOption[] = [];
  for (const o of p.options) {
    const r = asRecord(o);
    if (!r || typeof r.optionId !== 'string') continue;
    options.push({
      optionId: r.optionId,
      name: typeof r.name === 'string' ? r.name : r.optionId,
      kind: typeof r.kind === 'string' ? r.kind : '',
    });
  }
  return { sessionId: p.sessionId, toolCall, options };
}

type JsonRpcId = string | number;

function isId(v: unknown): v is JsonRpcId {
  return typeof v === 'string' || typeof v === 'number';
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
};

type Inflight = {
  /** `null`: an extension request that names no session — any cancel stops it (one session per agent process). */
  sessionId: string | null;
  abort: AbortController;
  answered: boolean;
  /** An extension request: its handler writes the reply, a cancel only tells it to stop waiting. */
  extension?: boolean;
};

/** After a cancel, how long an extension handler has to answer before the agent is answered for it. */
const EXTENSION_ABORT_GRACE_MS = 5_000;
/** JSON-RPC's "request cancelled" (LSP's code, which ACP agents share). */
const RPC_REQUEST_CANCELLED = -32800;

/* ── The transport ──────────────────────────────────────────────────────── */

export class AcpTransport {
  /** Non-JSON or oversized lines dropped so far. A quiet agent has 0; a rising
   *  count is the first symptom of a wrong binary or a chatty banner. */
  ignoredLines = 0;
  /** Replies nobody was waiting for (late after a timeout, or unknown id). */
  unmatchedResponses = 0;
  /** Notifications other than `session/update`, requests we could not honour. */
  unhandledMessages = 0;
  /** Callbacks that threw. Swallowed on purpose, counted so a test can see. */
  callbackErrors = 0;

  /** Resolves once, when the transport can no longer carry a request. */
  readonly closed: Promise<AcpCloseInfo>;

  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly inflight = new Map<JsonRpcId, Inflight>();
  private buffer = '';
  private discardingLine = false;
  private dead: AcpTransportError | null = null;
  private closeInfo: AcpCloseInfo = { reason: 'closed', exitCode: null, signal: null };
  private resolveClosed!: (info: AcpCloseInfo) => void;
  private streamEnded = false;
  private processExited: boolean;
  private closeTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  private proc: ChildProcess | null = null;
  private stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private stderrMax = DEFAULT_STDERR_MAX_BYTES;
  private killGraceMs = DEFAULT_KILL_GRACE_MS;

  private readonly io: AcpTransportOptions['io'];
  private readonly opts: AcpTransportOptions;
  private readonly onData = (chunk: string): void => this.ingest(chunk);
  private readonly onEnd = (): void => this.streamClosed();

  constructor(opts: AcpTransportOptions) {
    this.opts = opts;
    this.io = opts.io;
    this.processExited = true; // nothing to wait for until `attachProcess`
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.io.stdout.setEncoding('utf8');
    this.io.stdout.on('data', this.onData);
    this.io.stdout.on('end', this.onEnd);
    this.io.stdout.on('close', this.onEnd);
    // An EPIPE on a dead agent must be a failed request, not an uncaught error.
    this.io.stdin.on('error', () => { /* surfaced by the write callback and the close */ });
    this.io.stdout.on('error', () => this.streamClosed());
  }

  /** Starts the agent through the host adapter and speaks to it. */
  static spawn(opts: AcpSpawnOptions): AcpTransport {
    const proc = opts.spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // `spawn` never throws synchronously (host contract) but a missing pipe
    // would mean a wrong `stdio`: fail loudly rather than hang on a null.
    if (!proc.stdin || !proc.stdout) {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      throw new AcpTransportError('spawn', 'agent process has no stdio pipes');
    }
    const transport = new AcpTransport({
      io: { stdin: proc.stdin, stdout: proc.stdout },
      onSessionUpdate: opts.onSessionUpdate,
      onPermissionRequest: opts.onPermissionRequest,
      requestTimeoutMs: opts.requestTimeoutMs,
      promptTimeoutMs: opts.promptTimeoutMs,
      maxLineBytes: opts.maxLineBytes,
      clientVersion: opts.clientVersion,
    });
    if (opts.killGraceMs !== undefined && opts.killGraceMs > 0) transport.killGraceMs = opts.killGraceMs;
    if (opts.stderrMaxBytes !== undefined && opts.stderrMaxBytes > 0) transport.stderrMax = opts.stderrMaxBytes;
    transport.attachProcess(proc);
    return transport;
  }

  private attachProcess(proc: ChildProcess): void {
    this.proc = proc;
    this.processExited = proc.exitCode !== null || proc.signalCode !== null;
    proc.on('error', (err: Error) => {
      // ENOENT and friends arrive here; the message names the binary, not a secret.
      this.closeInfo = { reason: 'error', exitCode: null, signal: null };
      this.processExited = true;
      this.fail(new AcpTransportError('spawn', `could not start the agent: ${redactText(err.message)}`));
    });
    proc.on('exit', (code, signal) => {
      this.processExited = true;
      this.closeInfo = { reason: this.stopping ? 'closed' : 'exited', exitCode: code, signal };
      this.settleClose();
    });
    // Drained even when nobody reads it: a chatty agent must not fill the pipe
    // and stall. Only the tail is kept, and only ever handed out redacted.
    proc.stderr?.on('data', (chunk: Buffer | string) => this.keepStderr(chunk));
    proc.stderr?.on('error', () => { /* pipe torn down with the process */ });
  }

  /** The last `stderrMaxBytes` of the agent's stderr, secrets masked. The
   *  transport itself never logs it: whoever prints it takes that decision. */
  stderrTail(): string {
    return redactText(Buffer.concat(this.stderrChunks).toString('utf8'));
  }

  private keepStderr(chunk: Buffer | string): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.stderrChunks.push(buf);
    this.stderrBytes += buf.length;
    while (this.stderrBytes > this.stderrMax && this.stderrChunks.length > 0) {
      const head = this.stderrChunks[0]!;
      const over = this.stderrBytes - this.stderrMax;
      if (head.length <= over) {
        this.stderrChunks.shift();
        this.stderrBytes -= head.length;
      } else {
        this.stderrChunks[0] = head.subarray(over);
        this.stderrBytes -= over;
      }
    }
  }

  get alive(): boolean {
    return this.dead === null;
  }

  /* ── Reading ─────────────────────────────────────────────────────────── */

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (this.discardingLine) { this.discardingLine = false; continue; }
      this.handleLine(line);
    }
    const max = this.opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (this.buffer.length > max) {
      // The rest of this message, up to its newline, is dropped as well.
      this.buffer = '';
      if (!this.discardingLine) this.ignoredLines += 1;
      this.discardingLine = true;
    }
  }

  private handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { this.ignoredLines += 1; return; }
    const rec = asRecord(msg);
    if (!rec) { this.ignoredLines += 1; return; }
    if (typeof rec.method === 'string') {
      if (isId(rec.id)) this.handleRequest(rec.id, rec.method, rec.params);
      else this.handleNotification(rec.method, rec.params);
      return;
    }
    if (isId(rec.id) && ('result' in rec || 'error' in rec)) {
      this.handleResponse(rec.id, rec);
      return;
    }
    this.ignoredLines += 1;
  }

  private handleResponse(id: JsonRpcId, rec: AcpRecord): void {
    const p = this.pending.get(id);
    if (!p) { this.unmatchedResponses += 1; return; }
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    const err = asRecord(rec.error);
    if (err) {
      const code = typeof err.code === 'number' ? err.code : RPC_INTERNAL_ERROR;
      const text = typeof err.message === 'string' ? err.message : 'agent error';
      p.reject(new AcpRpcError(code, `${p.method}: ${redactText(text)}`, err.data));
      return;
    }
    p.resolve(rec.result);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') { this.unhandledMessages += 1; return; }
    const p = asRecord(params);
    if (!p) { this.ignoredLines += 1; return; }
    this.guarded(() => this.opts.onSessionUpdate?.(p));
  }

  private handleRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method === 'session/request_permission') {
      const req = parsePermissionRequest(params);
      if (!req) {
        this.reply(id, undefined, { code: RPC_INVALID_PARAMS, message: 'invalid session/request_permission params' });
        return;
      }
      void this.answerPermission(id, req);
      return;
    }
    if (this.opts.onExtensionRequest && this.opts.extensionMethods?.has(method)) {
      void this.answerExtension(id, method, params);
      return;
    }
    // `fs/*` and `terminal/*` are never offered in `initialize`, so a compliant
    // agent does not call them; one that does gets the standard answer, which
    // most agents already handle by falling back to their own tools.
    this.unhandledMessages += 1;
    this.reply(id, undefined, { code: RPC_METHOD_NOT_FOUND, message: `Method not found: ${method.slice(0, 120)}` });
  }

  private async answerPermission(id: JsonRpcId, req: AcpPermissionRequest): Promise<void> {
    const slot: Inflight = { sessionId: req.sessionId, abort: new AbortController(), answered: false };
    this.inflight.set(id, slot);
    let response: AcpPermissionResponse = { outcome: 'cancelled' };
    try {
      if (this.opts.onPermissionRequest) {
        const got = await this.opts.onPermissionRequest(req, slot.abort.signal);
        response = this.validOutcome(got, req);
      }
    } catch {
      this.callbackErrors += 1;
    }
    this.inflight.delete(id);
    if (slot.answered) return; // cancel or death already answered the agent
    slot.answered = true;
    this.reply(id, { outcome: response });
  }

  private async answerExtension(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const named = asRecord(params)?.sessionId;
    const slot: Inflight = { sessionId: typeof named === 'string' ? named : null, abort: new AbortController(), answered: false, extension: true };
    this.inflight.set(id, slot);
    let result: unknown = null;
    let failed = false;
    try {
      result = (await this.opts.onExtensionRequest!(method, params, slot.abort.signal)) ?? null;
      // A value the wire cannot carry is the handler's bug, answered as one.
      JSON.stringify(result);
    } catch {
      failed = true;
      this.callbackErrors += 1;
    }
    this.inflight.delete(id);
    if (slot.answered) return;
    slot.answered = true;
    if (failed) this.reply(id, undefined, { code: RPC_INTERNAL_ERROR, message: `the client could not answer ${method.slice(0, 120)}` });
    else this.reply(id, result);
  }

  /** An option id the agent did not offer is not an answer to its question. */
  private validOutcome(got: AcpPermissionResponse, req: AcpPermissionRequest): AcpPermissionResponse {
    if (got.outcome === 'selected' && req.options.some((o) => o.optionId === got.optionId)) return got;
    return { outcome: 'cancelled' };
  }

  private guarded(fn: () => void): void {
    try { fn(); } catch { this.callbackErrors += 1; }
  }

  /* ── Writing ─────────────────────────────────────────────────────────── */

  private reply(id: JsonRpcId, result?: unknown, error?: { code: number; message: string }): void {
    const body = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result: result ?? null };
    this.write(body);
  }

  private write(body: unknown, onError?: (err: Error) => void): void {
    if (this.dead) {
      onError?.(this.dead);
      return;
    }
    try {
      this.io.stdin.write(`${JSON.stringify(body)}\n`, (err) => {
        if (err) onError?.(new AcpTransportError('exited', 'the agent no longer reads its input'));
      });
    } catch {
      onError?.(new AcpTransportError('exited', 'the agent no longer reads its input'));
    }
  }

  /**
   * One request, one reply. Rejects with `AcpRpcError` when the agent answers
   * an error, `AcpTransportError` when it cannot answer (died, timed out,
   * transport stopped). `timeoutMs: 0` means no budget.
   */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    const budget = timeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { method, resolve, reject, timer: null };
      if (budget > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpTransportError('timeout', `${method}: no answer from the agent within ${budget} ms`));
        }, budget);
      }
      this.pending.set(id, entry);
      this.write({ jsonrpc: '2.0', id, method, params }, (err) => {
        if (this.pending.delete(id)) {
          if (entry.timer) clearTimeout(entry.timer);
          reject(err);
        }
      });
    });
  }

  /** A JSON-RPC notification: no id, no answer. */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /* ── ACP client methods ──────────────────────────────────────────────── */

  /** Handshake. Advertises NO client capability (no fs, no terminal): the
   *  agent works with its own tools and never asks us for either. */
  async initialize(): Promise<AcpRecord> {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'timon', version: this.opts.clientVersion ?? 'dev' },
    });
    const r = asRecord(result);
    if (!r) throw new AcpTransportError('protocol', 'initialize: the reply is not an object');
    return r;
  }

  /** Answers an `auth_required` with one of the methods the agent announced. The agent decides what it does
   *  (Cursor's `cursor_login` reuses the CLI's own sign-in); the call carries the method id and nothing else. */
  async authenticate(methodId: string, timeoutMs?: number): Promise<void> {
    await this.request('authenticate', { methodId }, timeoutMs);
  }

  /** Full `session/new` result (`configOptions`, `models`, `modes`… stay the
   *  dialect's to read) with the session id checked. */
  async newSession(params: { cwd: string; mcpServers: AcpMcpServer[] }): Promise<{ sessionId: string; result: AcpRecord }> {
    const r = asRecord(await this.request('session/new', params));
    if (!r || typeof r.sessionId !== 'string' || r.sessionId.length === 0) {
      throw new AcpTransportError('protocol', 'session/new: no sessionId in the reply');
    }
    return { sessionId: r.sessionId, result: r };
  }

  /** Reopens a session; the agent may replay its history as `session/update`s
   *  before replying (Hermes does, even for `resume`) — the caller decides what
   *  to do with them. `null` results (allowed by the spec) become `{}`. */
  async loadSession(params: { sessionId: string; cwd: string; mcpServers: AcpMcpServer[] }): Promise<AcpRecord> {
    return asRecord(await this.request('session/load', params)) ?? {};
  }

  async resumeSession(params: { sessionId: string; cwd: string; mcpServers: AcpMcpServer[] }): Promise<AcpRecord> {
    return asRecord(await this.request('session/resume', params)) ?? {};
  }

  /** One turn: resolves with the reply to `session/prompt`, which IS the end of
   *  the turn. Rejects if the agent dies first. */
  async prompt(sessionId: string, prompt: AcpContentBlock[], timeoutMs?: number): Promise<AcpPromptResult> {
    const r = asRecord(await this.request('session/prompt', { sessionId, prompt }, timeoutMs ?? this.opts.promptTimeoutMs ?? 0));
    if (!r || typeof r.stopReason !== 'string') {
      throw new AcpTransportError('protocol', 'session/prompt: no stopReason in the reply');
    }
    return { stopReason: r.stopReason, usage: parseUsage(r.usage) };
  }

  /**
   * Asks the agent to stop the running turn (a notification: the effect is the
   * prompt's own reply, `stopReason: 'cancelled'`). Permission asks still
   * waiting on us are answered `cancelled` right now, as the protocol requires,
   * and their handlers are told to stop waiting.
   */
  cancel(sessionId: string): void {
    for (const [id, slot] of this.inflight) {
      if (slot.answered || (slot.sessionId !== sessionId && !(slot.extension && slot.sessionId === null))) continue;
      if (slot.extension) {
        // The reply is in the provider's own shape: its handler writes it once told to stop. One that does not, in time, gets an error for it.
        if (slot.abort.signal.aborted) continue;
        slot.abort.abort();
        const grace = setTimeout(() => {
          if (slot.answered) return;
          slot.answered = true;
          this.reply(id, undefined, { code: RPC_REQUEST_CANCELLED, message: 'the request was cancelled' });
        }, EXTENSION_ABORT_GRACE_MS);
        grace.unref?.();
        continue;
      }
      slot.answered = true;
      slot.abort.abort();
      this.reply(id, { outcome: { outcome: 'cancelled' } });
    }
    this.notify('session/cancel', { sessionId });
  }

  /** Live model switch (`session/set_model`); opencode and Hermes both take it.
   *  Never during a turn — the caller's rule. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.request('session/set_model', { sessionId, modelId });
  }

  /** Sets one of the session's config options (`session/set_config_option`) and
   *  returns the options as they stand afterwards — which, for opencode, differ
   *  per model: the thinking levels follow the model. Never during a turn. */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<AcpRecord> {
    return asRecord(await this.request('session/set_config_option', { sessionId, configId, value })) ?? {};
  }

  /* ── End of life ─────────────────────────────────────────────────────── */

  private streamClosed(): void {
    if (this.streamEnded) return;
    this.streamEnded = true;
    // An agent that exits without a trailing newline still had a last message.
    if (this.buffer.trim() && !this.discardingLine) this.handleLine(this.buffer);
    this.buffer = '';
    this.settleClose();
  }

  /** Fails once both halves (stream ended, process exited) are known, or
   *  shortly after the first when the other never comes. */
  private settleClose(): void {
    if (this.dead) return;
    if (this.streamEnded && this.processExited) {
      this.failFromClose();
      return;
    }
    if (!this.closeTimer) {
      this.closeTimer = setTimeout(() => this.failFromClose(), CLOSE_SETTLE_MS);
    }
  }

  private failFromClose(): void {
    if (this.stopping) { this.fail(new AcpTransportError('closed', 'the transport was stopped')); return; }
    const { exitCode, signal } = this.closeInfo;
    const how = signal ? `signal ${signal}` : exitCode !== null ? `code ${exitCode}` : 'its output closed';
    this.fail(new AcpTransportError('exited', `the agent stopped (${how})`));
  }

  private fail(err: AcpTransportError): void {
    if (this.dead) return;
    this.dead = err;
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const [, slot] of this.inflight) {
      slot.answered = true; // nobody left to answer
      slot.abort.abort();
    }
    this.inflight.clear();
    this.io.stdout.off('data', this.onData);
    this.resolveClosed({ ...this.closeInfo, reason: err.kind === 'closed' ? 'closed' : this.closeInfo.reason });
  }

  /** Lets go: rejects what is pending, stops listening. Never touches the
   *  process. For a transport over pipes somebody else owns. */
  dispose(): void {
    this.stopping = true;
    this.fail(new AcpTransportError('closed', 'the transport was stopped'));
  }

  /**
   * `dispose()`, then — when this transport started the process — SIGTERM, and
   * SIGKILL after `killGraceMs`. Control comes back after at most twice that
   * delay even if the process refuses to die.
   */
  async stop(): Promise<void> {
    this.dispose();
    const proc = this.proc;
    if (!proc || this.processExited || proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(giveUpTimer);
        resolve();
      };
      const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, this.killGraceMs);
      const giveUpTimer = setTimeout(finish, this.killGraceMs * 2);
      proc.once('exit', finish);
      try { proc.kill('SIGTERM'); } catch { finish(); }
    });
  }
}
