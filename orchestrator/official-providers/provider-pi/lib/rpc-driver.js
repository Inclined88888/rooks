// @ts-check
/**
 * The `SessionDriver` of Pi in RPC mode (`pi --mode rpc`): JSON records on stdin and stdout, a
 * command answered by a `response` carrying its `id`, and session events in between. The runner
 * owns the process; the driver owns its two pipes for the whole session and never kills anything.
 *
 * The mapping onto the driver contract, as verified against Pi 1.4.0 (29/10/2026):
 *  - start   → `get_state`: the session id Pi opened (`--session-id` creates it or reopens it), the
 *              model, and `messageCount`, which tells a reopened conversation from a new one;
 *  - prompt  → `prompt`, answered at once (`disposition`: started, queued, handled); the turn ends
 *              with `agent_settled`, never with `agent_end`, which a retry or a steer follows;
 *  - cancel  → `abort`, then `agent_settled{aborted:true}`. Pi answers within milliseconds unless an
 *              extension holds a dialog that ignores the abort signal: past a grace period the turn
 *              is given up on, and the session refuses further prompts (the runner respawns it);
 *  - steer   → `prompt` with `streamingBehavior: 'steer'`: delivered before Pi's next LLM call;
 *  - setModel → `set_model`, between turns only.
 *
 * Framing: records are split on LF ONLY. Node's `readline` also splits on U+2028 and U+2029, which
 * JSON leaves raw inside strings: a model that writes one would cut its record in two (Pi's own
 * docs warn about it). Bytes are decoded with a `StringDecoder`, so a character split across two
 * chunks survives too.
 *
 * Rooks's tools (`bridge`): before the first prompt, the driver checks that the one `/rooks-bridge`
 * command Pi knows is the extension the provider wrote (`get_commands`, by its path), then sends it
 * the mission's MCP servers and its permission policy, with a nonce drawn for this session. The check
 * comes first because a message naming a command Pi does not know goes to the MODEL: an extension
 * that failed to load would otherwise hand it the token. The bridge's report is read only while that
 * command runs, and only under the nonce: any extension can write a `notify`.
 *
 * Permissions: the bridge gates every tool call and asks with a `confirm` titled with the nonce.
 * That dialog becomes the Allow/Deny card (`host.requestPermission`), its answer the dialog's.
 * Pi never says it dropped a dialog (its abort settles the dialog on its side, silently), so the
 * driver retires every open card itself when the turn ends, is cancelled, or the session goes, and
 * answers Pi `cancelled` for a dialog that might still wait. Every other dialog
 * (`confirm/select/input/editor` from another extension) is answered `cancelled` at once, so no
 * extension of the user's can leave a mission hanging. Fire-and-forget methods are ignored.
 *
 * Pi announces a call (`tool_execution_start`) BEFORE the gate decides on it: such a start is not
 * shown until Pi proves the call runs (an update, its end) or the card allowed it (`events.js`).
 *
 * @typedef {import('@rooks/sdk/provider').ImageAttachment} ImageAttachment
 * @typedef {import('@rooks/sdk/provider').NormalizedEvent} NormalizedEvent
 * @typedef {import('@rooks/sdk/provider').ProviderRuntime} ProviderRuntime
 * @typedef {import('@rooks/sdk/provider').SessionHost} SessionHost
 * @typedef {import('@rooks/sdk/provider').SessionInfo} SessionInfo
 * @typedef {import('@rooks/sdk/provider').SessionStdio} SessionStdio
 * @typedef {import('@rooks/sdk/provider').TurnOutcome} TurnOutcome
 * @typedef {Record<string, unknown>} PiRecord
 * @typedef {import('@rooks/sdk/provider').PermissionDecision} PermissionDecision
 * @typedef {import('@rooks/sdk/provider').PermissionRequest} PermissionRequest
 * @typedef {import('./rooks-bridge.js').ServerInput} ServerInput
 * @typedef {import('./rooks-bridge.js').BridgePolicy} BridgePolicy
 * The bridge of this launch: the extension file Pi was started with, the servers to hand it, and
 * the mission's permission policy.
 * @typedef {{ file: string, servers: readonly ServerInput[], policy: BridgePolicy }} BridgeLaunch
 *
 * @typedef {{
 *   io: SessionStdio,
 *   host: SessionHost,
 *   runtime: ProviderRuntime,
 *   profileId: string,
 *   resumeSession: string | null,
 *   bridge?: BridgeLaunch | null,
 *   requestTimeoutMs?: number,
 *   turnIdleTimeoutMs?: number,
 *   cancelGraceMs?: number,
 *   permissionWaitMs?: number,
 *   onClose?: () => void,
 * }} RpcDriverOptions
 *
 * @typedef {{
 *   detached: boolean,
 *   cancelled: boolean,
 *   timedOut: boolean,
 *   completed: boolean,
 *   idleTimer: NodeJS.Timeout | null,
 *   graceTimer: NodeJS.Timeout | null,
 *   resolve: (result: TurnResult) => void,
 *   done: Promise<TurnResult>,
 * }} Turn
 *
 * How a turn ended: Pi settled it; Pi never settled the cancelled turn; the pipes went away; the
 * prompt was refused before any run; an extension consumed the prompt and no run started.
 * @typedef {{ kind: 'settled', aborted: boolean } | { kind: 'forced' } | { kind: 'gone', message: string }
 *   | { kind: 'refused', message: string } | { kind: 'handled' }} TurnEnd
 * @typedef {{ outcome: TurnOutcome } | { error: string }} TurnResult
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { PiEventMapper, piToolName } from './events.js';
import { BRIDGE_COMMAND, BRIDGE_PERMISSION, BRIDGE_REPORT, encodeBridgeConfig } from './rooks-bridge.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** Silence, not duration: kept under the runner's own hung-turn reaper (45 min). */
const DEFAULT_TURN_IDLE_MS = 30 * 60_000;
const DEFAULT_CANCEL_GRACE_MS = 10_000;
/** The longest a card is waited for: past it the call is refused, as on the other protocol backends. */
const DEFAULT_PERMISSION_WAIT_MS = 40 * 60_000;
const MAX_ERROR_CHARS = 500;

/** Dialog methods: Pi waits for an `extension_ui_response`. */
const DIALOG_METHODS = new Set(['confirm', 'select', 'input', 'editor']);

/** @param {unknown} v @returns {PiRecord | null} */
function asRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? /** @type {PiRecord} */ (v) : null;
}

/** Whether Pi's model record (`get_state.model`, `set_model`'s reply) lists images among its inputs. @param {PiRecord | null} model */
function acceptsImages(model) {
  return Array.isArray(model?.input) && model.input.includes('image');
}

/** One line, bounded: a message that ends up in the chat and in `result`. @param {string} text */
function clip(text) {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > MAX_ERROR_CHARS ? `${one.slice(0, MAX_ERROR_CHARS)}…` : one;
}

/** Whether Pi's path for the extension names the file the provider wrote (case-insensitive where the file system is). @param {string} a @param {string} b */
function samePath(a, b) {
  const [x, y] = [resolve(a), resolve(b)];
  return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** `provider/model` as Pi names a model on its command line and in `set_model`. @param {unknown} model */
export function piModelSlug(model) {
  const m = asRecord(model);
  return m && typeof m.provider === 'string' && typeof m.id === 'string' ? `${m.provider}/${m.id}` : null;
}

export class RpcSessionDriver {
  /** @param {RpcDriverOptions} opts */
  constructor(opts) {
    this.opts = opts;
    this.mapper = new PiEventMapper(opts.runtime);
    /** @type {SessionInfo | null} */
    this.sessionInfo = null;
    /** @type {Turn | null} */
    this.turn = null;
    /** @type {Map<string, { resolve: (r: PiRecord) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    this.nextId = 0;
    this.stuck = false;
    this.closed = false;
    /** @type {string | null} Why the pipes are gone, once they are. */
    this.gone = null;
    /** @type {unknown} What the bridge reported at the end of its command (`notify`), once it has. */
    this.bridgeReport = undefined;
    /** @type {string | null} Drawn for this session: what the bridge's report and dialogs carry. */
    this.bridgeNonce = null;
    /** True only while the bridge command runs: a report outside that window is not the bridge's. */
    this.reportOpen = false;
    /** Open cards, by Pi's dialog id. @type {Map<string, AbortController>} */
    this.permissions = new Map();

    const decoder = new StringDecoder('utf8');
    const split = opts.runtime.engine.createLineSplitter((line) => this.onLine(line));
    /** @param {Buffer | string} chunk */
    this.onData = (chunk) => split(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    this.onEnd = () => this.lose('the Pi process closed its output');
    /** @param {Error} err */
    this.onWriteError = (err) => this.lose(`the Pi process stopped reading its input (${clip(err.message)})`);
    opts.io.stdout.on('data', this.onData);
    opts.io.stdout.on('end', this.onEnd);
    opts.io.stdout.on('close', this.onEnd);
    opts.io.stdin.on('error', this.onWriteError);
  }

  /** @returns {SessionInfo | null} */
  get info() {
    return this.sessionInfo;
  }

  /* ── Handshake ───────────────────────────────────────────────────────── */

  /** @returns {Promise<SessionInfo>} */
  async start() {
    if (this.sessionInfo) return this.sessionInfo;
    try {
      const state = asRecord((await this.request({ type: 'get_state' })).data) ?? {};
      const sessionId = typeof state.sessionId === 'string' && state.sessionId ? state.sessionId : null;
      if (!sessionId) throw new Error('Pi did not report a session (is it 1.4.0 or later?)');
      const model = asRecord(state.model);
      this.mapper.setModel(model);
      const bridged = this.opts.bridge ? await this.connectBridge(this.opts.bridge) : false;
      const asked = this.opts.resumeSession;
      // `--session-id` reopens the session when it exists and creates it otherwise: only history tells.
      const resumed = asked !== null && sessionId === asked && typeof state.messageCount === 'number' && state.messageCount > 0;
      this.sessionInfo = {
        sessionId,
        capabilities: {
          loadSession: true,
          resume: true,
          // Rooks's MCP servers, declared to Pi by the bridge extension.
          mcp: bridged,
          image: acceptsImages(model),
          // Without the bridge nothing gates Pi's tools: it decides them alone, and the UI says so.
          ...(bridged ? {} : { permissionsByAgent: true }),
        },
        resumed,
      };
      const init = this.opts.runtime.events.systemInitEvent({
        sessionId,
        backend: this.opts.profileId,
        ...(piModelSlug(model) ? { model: /** @type {string} */ (piModelSlug(model)) } : {}),
      });
      this.emit([bridged ? init : { ...init, payload: { .../** @type {PiRecord} */ (init.payload), permissions_by_agent: true } }]);
      return this.sessionInfo;
    } catch (err) {
      this.close();
      throw new Error(err instanceof Error ? clip(err.message) : 'the Pi session could not start');
    }
  }

  /**
   * Hands the bridge extension the mission's MCP servers. Throws, sending nothing, when the
   * `/rooks-bridge` Pi would run is not the provider's file; a server that does not start only
   * costs its own tools (the bridge says so on Pi's stderr).
   * @param {BridgeLaunch} bridge
   * @returns {Promise<boolean>}
   */
  async connectBridge(bridge) {
    const listed = asRecord((await this.request({ type: 'get_commands' })).data)?.commands;
    const named = (Array.isArray(listed) ? listed : []).map(asRecord).filter((c) => c?.name === BRIDGE_COMMAND);
    const info = asRecord(named[0]?.sourceInfo);
    if (named.length !== 1 || named[0]?.source !== 'extension' || typeof info?.path !== 'string' || !samePath(info.path, bridge.file)) {
      throw new Error(named.length === 0
        ? 'Pi did not load Rooks\'s bridge extension: Rooks\'s tools cannot reach this session'
        : `another Pi extension also registers \`/${BRIDGE_COMMAND}\`: Rooks does not hand it the mission's tools`);
    }
    const nonce = randomBytes(16).toString('hex');
    this.bridgeNonce = nonce;
    this.bridgeReport = undefined;
    this.reportOpen = true;
    /** @type {PiRecord} */
    let reply;
    try {
      reply = await this.request({ type: 'prompt', message: encodeBridgeConfig(bridge.servers, { nonce, policy: bridge.policy }) });
    } finally {
      // Pi writes the command's `notify` before it answers the prompt: the window closes with the answer.
      this.reportOpen = false;
    }
    if (reply.success !== true || asRecord(reply.data)?.disposition !== 'handled') {
      // Pi's own error is not repeated: it may quote the command, which carries the swapped values.
      throw new Error('Pi did not run the bridge command');
    }
    const report = asRecord(this.bridgeReport);
    if (!report) throw new Error('Rooks\'s bridge extension did not report its configuration');
    if (typeof report.error === 'string') throw new Error(`Rooks's bridge extension refused its configuration (${report.error})`);
    return true;
  }

  /* ── Turns ───────────────────────────────────────────────────────────── */

  /**
   * @param {string} text
   * @param {ImageAttachment[]} [images]
   * @returns {Promise<TurnOutcome>}
   */
  async prompt(text, images) {
    if (!this.sessionInfo) throw new Error('the session is not started');
    if (this.closed) throw new Error('the session is closed');
    if (this.gone) throw new Error(this.gone);
    if (this.stuck) throw new Error('Pi did not stop the cancelled turn: start a new session');
    if (this.turn && !this.turn.detached) throw new Error('a turn is already running');
    // A run Pi started on its own is still going: a prompt now would be refused as "already processing".
    if (this.turn) await this.turn.done;

    const turn = this.openTurn(false);
    const sendImages = Boolean(images?.length) && this.sessionInfo.capabilities.image;
    /** @type {PiRecord} */
    const command = { type: 'prompt', message: text };
    if (images?.length && !sendImages) {
      // The note comes first: the message is what the model answers, so it stays the last thing it reads.
      command.message = `[${images.length} image(s) not sent: the selected model does not accept images]\n\n${text}`;
    }
    if (sendImages && images) command.images = images.map((img) => ({ type: 'image', data: img.data, mimeType: img.media_type }));

    this.request(command).then((reply) => {
      if (reply.success !== true) {
        this.complete(turn, { kind: 'refused', message: typeof reply.error === 'string' ? reply.error : 'Pi refused the prompt' });
      } else if (asRecord(reply.data)?.disposition === 'handled') {
        // Consumed by an extension command or an input handler: no run started, nothing will settle.
        this.complete(turn, { kind: 'handled' });
      }
    }, (/** @type {unknown} */ err) => {
      this.complete(turn, { kind: 'refused', message: err instanceof Error ? err.message : 'the Pi session failed' });
    });
    const result = await turn.done;
    if ('error' in result) throw new Error(result.error);
    return result.outcome;
  }

  /** @param {boolean} detached @returns {Turn} */
  openTurn(detached) {
    /** @type {(result: TurnResult) => void} */
    let resolve = () => undefined;
    /** @type {Promise<TurnResult>} */
    const done = new Promise((r) => { resolve = r; });
    /** @type {Turn} */
    const turn = { detached, cancelled: false, timedOut: false, completed: false, idleTimer: null, graceTimer: null, resolve, done };
    this.mapper.beginTurn();
    this.turn = turn;
    this.armIdle();
    return turn;
  }

  /**
   * Ends the turn: its ONE `result` goes out now, synchronously, before any later record is read —
   * a run that follows in the same chunk must not find the mapper still holding this one.
   * @param {Turn} turn
   * @param {TurnEnd} end
   */
  complete(turn, end) {
    if (turn.completed) return;
    turn.completed = true;
    // Pi's abort settled its dialogs without a word: the cards they raised go with the turn.
    this.retirePermissions();
    this.endTurn(turn);
    const timeout = turn.timedOut ? 'Pi produced nothing for too long: the turn was stopped' : null;
    /** @type {TurnResult} */
    let result;
    switch (end.kind) {
      case 'gone':
        this.emit(this.mapper.finish({ error: end.message }));
        // The process is gone: the runner decides what becomes of the mission.
        result = { error: end.message };
        break;
      case 'forced':
        this.stuck = true;
        this.emit(this.mapper.finish({ aborted: true, error: timeout }));
        result = { outcome: { stopReason: 'cancelled' } };
        break;
      case 'refused': {
        const message = clip(end.message);
        this.emit(this.mapper.finish({ error: message }));
        result = this.gone ? { error: message } : { outcome: { stopReason: 'error' } };
        break;
      }
      case 'handled':
        this.emit(this.mapper.finish({}));
        result = { outcome: { stopReason: 'end_turn' } };
        break;
      default: {
        const events = this.mapper.finish({ aborted: end.aborted, error: timeout });
        this.emit(events);
        const failed = asRecord(events[0]?.payload)?.is_error === true;
        result = { outcome: { stopReason: failed ? 'error' : end.aborted ? 'cancelled' : 'end_turn' } };
      }
    }
    turn.resolve(result);
  }

  /** @returns {Promise<void>} */
  async cancel() {
    const turn = this.turn;
    if (!turn || turn.cancelled || this.closed || this.gone) return;
    this.stop(turn);
  }

  /** Asks Pi to stop, and gives up waiting if it does not. @param {Turn} turn */
  stop(turn) {
    turn.cancelled = true;
    // A Stop answers the open cards now: nobody should be left looking at one for a call that will not run.
    this.retirePermissions();
    // The answer comes after `agent_settled`, which is what the turn waits for.
    this.request({ type: 'abort' }).catch(() => undefined);
    if (!turn.graceTimer) {
      turn.graceTimer = setTimeout(() => this.complete(turn, { kind: 'forced' }), this.opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
      turn.graceTimer.unref?.();
    }
  }

  /**
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async steer(text) {
    const turn = this.turn;
    if (!turn || turn.cancelled || this.closed || this.gone) return false;
    try {
      const reply = await this.request({ type: 'prompt', message: text, streamingBehavior: 'steer' });
      // `started`: the turn settled meanwhile and the message opened a run of its own, which the
      // driver follows like any run it did not ask for (`onEvent`). Pi took it either way.
      return reply.success === true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} model `provider/id` (`pi --list-models`), or a bare id Pi resolves among its models.
   * @returns {Promise<boolean>}
   */
  async setModel(model) {
    if (this.turn || this.closed || this.gone || !this.sessionInfo) return false;
    const want = model.trim();
    if (!want) return false;
    try {
      const slash = want.indexOf('/');
      let provider = slash > 0 ? want.slice(0, slash) : null;
      const modelId = slash > 0 ? want.slice(slash + 1) : want;
      if (!provider) {
        const listed = asRecord((await this.request({ type: 'get_available_models' })).data)?.models;
        const match = Array.isArray(listed) ? listed.map(asRecord).find((m) => m?.id === want) : null;
        if (!match || typeof match.provider !== 'string') return false;
        provider = match.provider;
      }
      const reply = await this.request({ type: 'set_model', provider, modelId });
      if (reply.success !== true) return false;
      this.mapper.setModel(reply.data);
      // The next prompt sends its images, or says they were left out, by what the NEW model takes.
      const image = acceptsImages(asRecord(reply.data));
      if (this.sessionInfo && this.sessionInfo.capabilities.image !== image) {
        this.sessionInfo = { ...this.sessionInfo, capabilities: { ...this.sessionInfo.capabilities, image } };
      }
      return true;
    } catch {
      return false;
    }
  }

  endTurn(/** @type {Turn} */ turn) {
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    turn.idleTimer = null;
    turn.graceTimer = null;
    if (this.turn === turn) this.turn = null;
  }

  /** Restarts the silence timer of the running turn. */
  armIdle() {
    const turn = this.turn;
    if (!turn) return;
    if (turn.idleTimer) { clearTimeout(turn.idleTimer); turn.idleTimer = null; }
    const limit = this.opts.turnIdleTimeoutMs ?? DEFAULT_TURN_IDLE_MS;
    // A card waits for a human, who may take long: that silence is not Pi's (the card has its own ceiling).
    if (limit <= 0 || turn.cancelled || this.permissions.size > 0) return;
    turn.idleTimer = setTimeout(() => {
      turn.timedOut = true;
      this.stop(turn);
    }, limit);
    turn.idleTimer.unref?.();
  }

  /* ── The wire ────────────────────────────────────────────────────────── */

  /**
   * Sends a command and waits for the `response` that carries its id.
   * @param {PiRecord} command
   * @returns {Promise<PiRecord>}
   */
  request(command) {
    if (this.closed) return Promise.reject(new Error('the session is closed'));
    if (this.gone) return Promise.reject(new Error(this.gone));
    this.nextId += 1;
    const id = `rooks-${this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi did not answer \`${String(command.type)}\` in time`));
      }, this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...command, id });
    });
  }

  /** @param {PiRecord} record */
  write(record) {
    try {
      this.opts.io.stdin.write(`${JSON.stringify(record)}\n`);
    } catch (err) {
      this.lose(`the Pi process stopped reading its input (${clip(err instanceof Error ? err.message : String(err))})`);
    }
  }

  /** @param {string} line */
  onLine(line) {
    if (this.closed) return;
    const record = this.opts.runtime.jsonLines.parseJsonObjectLine(line);
    // Stdout is reserved for protocol records; anything else is not ours to read.
    if (!record) return;
    if (record.type === 'response') {
      const id = typeof record.id === 'string' ? record.id : null;
      const waiter = id ? this.pending.get(id) : undefined;
      if (!waiter || !id) return;
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.resolve(record);
      return;
    }
    if (record.type === 'extension_ui_request') {
      this.onExtensionRequest(record);
      return;
    }
    this.onEvent(record);
  }

  /** @param {PiRecord} record */
  onExtensionRequest(record) {
    if (record.method === 'notify' && typeof record.message === 'string' && record.message.startsWith(BRIDGE_REPORT)) {
      // Any extension can write this: only the bridge, while its command runs, knows the nonce.
      if (!this.reportOpen || !this.bridgeNonce) return;
      /** @type {unknown} */
      let report = null;
      try { report = JSON.parse(record.message.slice(BRIDGE_REPORT.length)); } catch { /* not a report */ }
      if (asRecord(report)?.nonce === this.bridgeNonce) this.bridgeReport = report;
      return;
    }
    const id = typeof record.id === 'string' ? record.id : null;
    if (!id || typeof record.method !== 'string' || !DIALOG_METHODS.has(record.method)) return;
    if (record.method === 'confirm' && this.bridgeNonce && record.title === `${BRIDGE_PERMISSION}${this.bridgeNonce}` && !this.permissions.has(id)) {
      this.askPermission(id, record.message);
      return;
    }
    this.write({ type: 'extension_ui_response', id, cancelled: true });
  }

  /* ── Permissions ─────────────────────────────────────────────────────── */

  /**
   * A call the bridge asks about, through the Allow/Deny card; Pi gets the card's answer. A dialog
   * the driver retired meanwhile (the turn ended) is not answered again.
   * @param {string} id Pi's dialog id
   * @param {unknown} message the bridge's JSON: `{ toolCallId, tool, input }`
   */
  askPermission(id, message) {
    /** @type {PiRecord | null} */
    let call = null;
    try { call = typeof message === 'string' ? asRecord(JSON.parse(message)) : null; } catch { /* malformed */ }
    if (!call || typeof call.tool !== 'string' || !call.tool) {
      this.write({ type: 'extension_ui_response', id, confirmed: false });
      return;
    }
    const toolCallId = typeof call.toolCallId === 'string' && call.toolCallId ? call.toolCallId : null;
    /** @type {PermissionRequest} */
    const request = {
      toolCallId,
      // `Bash` with its `command`, as the card and the paste button read a shell call.
      tool: piToolName(call.tool),
      title: null,
      input: call.input ?? {},
    };
    const controller = new AbortController();
    this.permissions.set(id, controller);
    this.armIdle();
    void this.decide(request, controller).then((decision) => {
      if (this.permissions.get(id) !== controller) return;
      this.permissions.delete(id);
      this.write({ type: 'extension_ui_response', id, confirmed: decision.allow });
      // The start Pi announced before the gate: shown now that the call runs.
      if (decision.allow && toolCallId) this.emit(this.mapper.release(toolCallId));
      this.armIdle();
    });
  }

  /**
   * The card's answer, or a denial: a host that rejects, a wait past the ceiling (which retires the
   * card), a dialog retired by the driver.
   * @param {PermissionRequest} request
   * @param {AbortController} controller
   * @returns {Promise<PermissionDecision>}
   */
  async decide(request, controller) {
    /** @type {PermissionDecision} */
    const deny = { allow: false };
    if (controller.signal.aborted) return deny;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    /** @type {(() => void) | undefined} */
    let onAbort;
    /** @type {Promise<PermissionDecision>} */
    const ceiling = new Promise((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(deny); }, this.opts.permissionWaitMs ?? DEFAULT_PERMISSION_WAIT_MS);
      timer.unref?.();
      onAbort = () => resolve(deny);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const asked = Promise.resolve()
        .then(() => this.opts.host.requestPermission(request, { signal: controller.signal }))
        .catch(() => deny);
      return await Promise.race([asked, ceiling]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Retires every open card, and answers Pi in case a dialog still waits (an answer to one it dropped is ignored). */
  retirePermissions() {
    if (this.permissions.size === 0) return;
    const open = [...this.permissions];
    this.permissions.clear();
    for (const [id, controller] of open) {
      controller.abort();
      if (!this.closed && !this.gone) this.write({ type: 'extension_ui_response', id, cancelled: true });
    }
  }

  /** @param {PiRecord} record */
  onEvent(record) {
    // A run nobody prompted for (a steer that arrived as the turn settled, an extension's own
    // message): followed like a turn, so its words and its `result` are not lost.
    if (!this.turn && record.type === 'agent_start' && this.sessionInfo) this.openTurn(true);
    const turn = this.turn;
    if (!turn) return;
    this.armIdle();
    this.emit(this.mapper.map(record));
    if (record.type === 'agent_settled') this.complete(turn, { kind: 'settled', aborted: record.aborted === true });
  }

  /** @param {NormalizedEvent[]} events */
  emit(events) {
    for (const ev of events) {
      try {
        this.opts.host.emit(ev);
      } catch {
        // A persistence hiccup on one line must not tear the session down.
      }
    }
  }

  /* ── End of life ─────────────────────────────────────────────────────── */

  /** The pipes are gone: nothing pending may hang. @param {string} message */
  lose(message) {
    if (this.gone || this.closed) return;
    this.gone = message;
    this.retirePermissions();
    this.rejectPending(message);
    if (this.turn) this.complete(this.turn, { kind: 'gone', message });
  }

  /** @param {string} message */
  rejectPending(message) {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  close() {
    if (this.closed) return;
    if (this.turn) this.complete(this.turn, { kind: 'gone', message: 'the session is closed' });
    this.retirePermissions();
    this.rejectPending('the session is closed');
    this.closed = true;
    this.opts.io.stdout.off('data', this.onData);
    this.opts.io.stdout.off('end', this.onEnd);
    this.opts.io.stdout.off('close', this.onEnd);
    this.opts.io.stdin.off('error', this.onWriteError);
    this.opts.onClose?.();
  }
}
