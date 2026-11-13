// src/gateway.ts
var MIN_VERSION = "0.21.0";
var RECOMMENDED_VERSION = "0.21.6";
var GatewayError = class extends Error {
  constructor(message, status, code, retryAfterMs = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.name = "GatewayError";
  }
  status;
  code;
  retryAfterMs;
};
var GatewayUnreachableError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayUnreachableError";
  }
};
function joinUrl(base, path) {
  return new URL(path.replace(/^\//, ""), base);
}
function targetUrls(connectionUrl, profile) {
  const root = new URL(connectionUrl.endsWith("/") ? connectionUrl : `${connectionUrl}/`);
  const base = profile === "default" ? root : new URL(`p/${encodeURIComponent(profile)}/`, root);
  return { root, base };
}
function headers(target, extra = {}) {
  return {
    authorization: `Bearer ${target.key}`,
    ...target.sessionKey ? { "x-hermes-session-key": target.sessionKey } : {},
    ...extra
  };
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function short(text, max = 200) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}\u2026` : flat;
}
function retryAfter(response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 300) * 1e3;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 3e5)) : null;
}
function describeStatus(status, code, hermesMessage, profile) {
  if (status === 401 || status === 403) {
    return profile === "default" ? "The Hermes gateway refused the API key. Check the key of your connection in Settings \u203A Secrets \u203A Connections." : `The Hermes gateway refused the API key for profile "${profile}". A profile has its own key: check it in Settings \u203A Secrets \u203A Connections.`;
  }
  if (status === 404 && code !== "run_not_found") {
    return profile === "default" ? "The Hermes gateway does not serve this address. Check the URL of your connection, and that its API server is enabled." : `The Hermes gateway does not know the profile "${profile}". Check the profile name of your connection.`;
  }
  if (status === 429) return "The Hermes gateway is running as many tasks as it allows. Try again in a moment.";
  const detail = hermesMessage ? `: ${short(hermesMessage)}` : "";
  return `The Hermes gateway answered HTTP ${status}${code ? ` (${code})` : ""}${detail}`;
}
async function send(fetch, url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    const name2 = err instanceof Error ? err.name : "";
    if (name2 === "PluginPolicyError" || name2 === "DestinationRefusedError") {
      throw new GatewayUnreachableError(`Rooks refused to reach this gateway: ${err instanceof Error ? short(err.message) : "refused"}`);
    }
    if (err instanceof Error && /redirect/i.test(err.message)) {
      throw new GatewayUnreachableError("The Hermes gateway redirected the request: put its final address in your connection.");
    }
    throw new GatewayUnreachableError(`The Hermes gateway at ${url.origin} cannot be reached.`);
  }
}
async function call(fetch, target, method, path, options = {}) {
  const url = joinUrl(options.root ? target.root : target.base, path);
  const response = await send(fetch, url, {
    method,
    headers: headers(target, {
      accept: "application/json",
      ...options.body !== void 0 ? { "content-type": "application/json" } : {},
      ...options.extraHeaders
    }),
    ...options.body !== void 0 ? { body: JSON.stringify(options.body) } : {},
    ...options.signal ? { signal: options.signal } : {},
    redirect: "error"
  });
  let parsed = null;
  const text = await response.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const body = record(parsed) ?? {};
  if (!response.ok) {
    const error = record(body.error);
    const code = typeof error?.code === "string" ? error.code : null;
    const message = typeof error?.message === "string" ? error.message : typeof body.error === "string" ? body.error : null;
    throw new GatewayError(describeStatus(response.status, code, message, target.profile), response.status, code, retryAfter(response));
  }
  return { status: response.status, body, response };
}
function feature(features, name2) {
  const value = features[name2];
  if (value === true) return true;
  const object = record(value);
  return object?.supported === true || object?.enabled === true;
}
function missingFeatures(capabilities) {
  const features = record(capabilities.features) ?? {};
  const missing = ["run_submission", "run_events_sse", "run_status", "run_stop", "run_steer", "run_approval_response"].filter((name2) => !feature(features, name2));
  const idempotency = record(features.runs_idempotency);
  if (idempotency?.durable !== true) missing.push("runs_idempotency.durable");
  return missing;
}
function versionTooOld(missing) {
  return `This Hermes gateway is too old for Rooks (missing: ${missing.join(", ")}). Update Hermes to ${MIN_VERSION} or later; ${RECOMMENDED_VERSION} is recommended.`;
}
async function health(fetch, target, signal) {
  const response = await send(fetch, joinUrl(target.root, "health"), {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    ...signal ? { signal } : {}
  });
  let body = null;
  try {
    body = record(await response.json());
  } catch {
    body = null;
  }
  const version = typeof body?.version === "string" && body.version !== "unknown" ? body.version : null;
  return { ok: response.ok, version };
}
async function checkGateway(fetch, target, signal) {
  try {
    const live = await health(fetch, target, signal);
    if (!live.ok) return { ok: false, message: "The Hermes gateway answered, but its health check failed. Is its API server enabled?" };
    const { body } = await call(fetch, target, "GET", "v1/capabilities", signal ? { signal } : {});
    const missing = missingFeatures(body);
    if (missing.length > 0) return { ok: false, message: versionTooOld(missing) };
    let model = null;
    try {
      const models = await call(fetch, target, "GET", "v1/models", signal ? { signal } : {});
      const first = Array.isArray(models.body.data) ? record(models.body.data[0]) : null;
      model = typeof first?.id === "string" ? first.id : null;
    } catch {
      model = null;
    }
    return { ok: true, version: live.version, model };
  } catch (err) {
    if (err instanceof GatewayError || err instanceof GatewayUnreachableError) return { ok: false, message: err.message };
    if (signal?.aborted) return { ok: false, message: "The connection test was cancelled." };
    return { ok: false, message: "The Hermes gateway answered something Rooks cannot read." };
  }
}
function compareVersions(a, b) {
  const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number) ?? null;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

// src/connection.ts
var TYPE_NAME = "gateway";
var TYPE_VERSION = 1;
var SECRET_KEY = "apiKey";
var MODEL_PREFIX = "hermes/";
var DEFAULT_PROFILE = "default";
var PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function qualifiedType(pluginId) {
  return `${pluginId}:${TYPE_NAME}@${TYPE_VERSION}`;
}
var UserFacingError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UserFacingError";
  }
};
function record2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
var configSchema = {
  parse(value) {
    const object = record2(value);
    if (!object) throw new Error("Expected an object");
    const { profile, ...rest } = object;
    if (Object.keys(rest).length > 0) throw new Error("Unknown field");
    if (profile === void 0 || profile === null || profile === "") return {};
    if (typeof profile !== "string") throw new Error("Invalid profile");
    const name2 = profile.trim();
    if (!name2 || name2 === DEFAULT_PROFILE) return {};
    if (!PROFILE_RE.test(name2)) throw new Error('A profile name is letters, digits, ".", "_" or "-"');
    return { profile: name2 };
  }
};
function connectionProfile(connection) {
  const profile = connection.config.profile;
  return typeof profile === "string" && profile.trim() ? profile.trim() : DEFAULT_PROFILE;
}
var CONNECTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
function parseModel(model) {
  if (!model || !model.startsWith(MODEL_PREFIX)) return null;
  const rest = model.slice(MODEL_PREFIX.length).trim();
  if (!rest) return null;
  const slash = rest.indexOf("/");
  if (slash < 0) return { profile: rest, connectionId: null };
  const connectionId = rest.slice(0, slash);
  const profile = rest.slice(slash + 1);
  if (!CONNECTION_ID_RE.test(connectionId) || !PROFILE_RE.test(profile)) return { profile: rest, connectionId: null };
  return { profile, connectionId };
}
function modelOfProfile(profile) {
  return `${MODEL_PREFIX}${profile}`;
}
function modelOfConnection(connection) {
  return `${MODEL_PREFIX}${connection.id}/${connectionProfile(connection)}`;
}
function sessionKeyFor(ownerUserId) {
  return `rooks:${ownerUserId}`;
}
function usable(connection) {
  return connection.enabled && connection.approval === "approved";
}
var NO_CONNECTION = "No Hermes gateway is configured for your account: add one in Settings \u203A Secrets \u203A Connections.";
var NOT_YOUR_CONNECTION = "This Hermes agent is tied to one gateway connection, and your account has no such connection: it was deleted, or it belongs to another account. Use your own Hermes agents (Settings \u203A Hermes Gateway \u203A Add my Hermes agents to Rooks).";
function pickConnection(mine, model) {
  const wanted = parseModel(model);
  if (wanted?.connectionId) {
    const pinned = mine.find((c) => c.id === wanted.connectionId);
    if (!pinned) throw new UserFacingError(NOT_YOUR_CONNECTION);
    const serves = connectionProfile(pinned);
    if (serves !== wanted.profile) {
      throw new UserFacingError(
        `Your Hermes gateway connection "${pinned.label}" now serves the profile "${serves}", not "${wanted.profile}": click "Add my Hermes agents to Rooks" in Settings \u203A Hermes Gateway again.`
      );
    }
    if (!usable(pinned)) throw new UserFacingError(unusableReason(pinned));
    return pinned;
  }
  if (mine.length === 0) throw new UserFacingError(NO_CONNECTION);
  const profile = wanted?.profile ?? null;
  const candidates = profile ? mine.filter((c) => connectionProfile(c) === profile) : mine;
  if (candidates.length === 0) {
    throw new UserFacingError(`None of your Hermes gateway connections serves the profile "${profile}": add one with that profile in Settings \u203A Secrets \u203A Connections.`);
  }
  const live = candidates.filter(usable);
  const pick = profile ? live[0] : live.find((c) => connectionProfile(c) === DEFAULT_PROFILE) ?? live[0];
  if (!pick) throw new UserFacingError(unusableReason(candidates[0]));
  return pick;
}
function unusableReason(connection) {
  if (connection.approval === "pending") {
    return "Your Hermes gateway connection is waiting for an administrator to approve its address (Settings \u203A Secrets \u203A Connections).";
  }
  if (connection.approval === "rejected") {
    return "An administrator refused the address of your Hermes gateway connection (Settings \u203A Secrets \u203A Connections).";
  }
  return "Your Hermes gateway connection is turned off (Settings \u203A Secrets \u203A Connections).";
}
async function resolveTarget(connections, typeId, launch, model) {
  if (!launch || launch.kind !== "mission") {
    throw new UserFacingError("A Hermes gateway agent runs only in a mission, on behalf of the account that launched it.");
  }
  const owner = launch.ownerUserId;
  if (!owner || owner.startsWith("plugin:")) {
    throw new UserFacingError(
      "This mission was not launched by an account (an unassigned Kanban task, a routine or a plugin). A Hermes gateway agent uses the gateway of the account that launches it: start it from your account."
    );
  }
  let mine;
  try {
    mine = (await connections.forUser(owner)).filter((c) => c.type === typeId);
  } catch {
    throw new UserFacingError("Your account is not allowed to use the Hermes Gateway plugin. Ask an administrator.");
  }
  const pick = pickConnection(mine, model);
  const key = await connections.userSecret(owner, pick.id, SECRET_KEY);
  if (!key) throw new UserFacingError("Your Hermes gateway connection has no API key: set it in Settings \u203A Secrets \u203A Connections.");
  const profile = connectionProfile(pick);
  const { root, base } = targetUrls(pick.url, profile);
  return { root, base, profile, key, sessionKey: sessionKeyFor(owner) };
}
function connectionType() {
  return {
    name: TYPE_NAME,
    version: TYPE_VERSION,
    label: "Hermes Gateway",
    description: "A Hermes gateway API server (Hermes 0.21.0 or later). One connection per Hermes profile; a profile has its own key.",
    configSchema,
    fields: [{ key: "profile", label: "Hermes profile (empty: default)", placeholder: DEFAULT_PROFILE }],
    secrets: [{ name: SECRET_KEY, label: "API server key (API_SERVER_KEY)", required: true }],
    timeoutMs: 15e3,
    async test(context) {
      const key = await context.secret(SECRET_KEY);
      if (!key) return { ok: false, message: "Set the API server key first." };
      const profile = connectionProfile(context.connection);
      const { root, base } = targetUrls(context.connection.url, profile);
      const fetch = (input, init) => context.fetch(input, init);
      const result = await checkGateway(fetch, { root, base, profile, key, sessionKey: null }, context.signal);
      if (!result.ok) return result;
      const old = result.version ? compareVersions(result.version, RECOMMENDED_VERSION) : null;
      const version = result.version ? `Hermes ${result.version}` : "Hermes (version not reported)";
      const advice = old !== null && old < 0 ? ` Update to ${RECOMMENDED_VERSION} or later so a cut stream can resume.` : "";
      return { ok: true, message: `${version}, profile "${result.model ?? profile}".${advice}` };
    }
  };
}

// src/driver.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// src/events.ts
import { randomUUID } from "node:crypto";
var SUBAGENT_TOOL = "hermes_subagent";
function str(value) {
  return typeof value === "string" ? value : null;
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function record3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function parseEvent(data) {
  try {
    const value = record3(JSON.parse(data));
    return value && typeof value.event === "string" ? value : null;
  } catch {
    return null;
  }
}
function assistant(content) {
  return { type: "assistant", payload: { type: "assistant", message: { id: randomUUID(), role: "assistant", content } } };
}
function toolResult(id, text, isError) {
  return {
    type: "user",
    payload: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } }
  };
}
function usage(value) {
  const u = record3(value);
  if (!u) return null;
  const out = {};
  const pairs = [
    ["input_tokens", "input_tokens"],
    ["output_tokens", "output_tokens"],
    ["cache_read_tokens", "cache_read_input_tokens"],
    ["cache_write_tokens", "cache_creation_input_tokens"]
  ];
  for (const [from, to] of pairs) {
    const n = num(u[from]);
    if (n !== null) out[to] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}
var TurnMapper = class {
  constructor(idPrefix) {
    this.idPrefix = idPrefix;
  }
  idPrefix;
  /** Answer text streamed since the last assistant message was emitted. */
  buffer = "";
  /** Last assistant text emitted, for the result line. */
  lastText = "";
  /** `reasoning.available`: the answer once more, kept as a last resort. */
  fallbackText = "";
  openTools = /* @__PURE__ */ new Map();
  toolCount = 0;
  /** The tool name of the last call, for an approval card (the request has none). */
  lastTool = null;
  ended = false;
  /** True once `finish` produced the result line. */
  get finished() {
    return this.ended;
  }
  map(ev) {
    if (this.ended) return [];
    switch (ev.event) {
      case "message.delta": {
        const delta = str(ev.delta);
        if (!delta) return [];
        this.buffer += delta;
        return [{ type: "assistant_delta", payload: { text: delta, mode: "append" } }];
      }
      case "message.interim": {
        const text = str(ev.text) ?? "";
        if (ev.already_streamed === true) return this.flush(text);
        return [...this.flush(), ...this.text(text)];
      }
      case "reasoning.available": {
        this.fallbackText = str(ev.text) ?? this.fallbackText;
        return [];
      }
      case "tool.started": {
        const tool = str(ev.tool) ?? "tool";
        const id = `${this.idPrefix}-tool-${++this.toolCount}`;
        const queue = this.openTools.get(tool) ?? [];
        queue.push(id);
        this.openTools.set(tool, queue);
        this.lastTool = tool;
        const preview = str(ev.preview);
        return [...this.flush(), assistant([{ type: "tool_use", id, name: tool, input: preview ? { preview } : {} }])];
      }
      case "tool.completed": {
        const tool = str(ev.tool) ?? "tool";
        const queue = this.openTools.get(tool);
        let id = queue?.shift();
        const out = this.flush();
        if (!id) {
          id = `${this.idPrefix}-tool-${++this.toolCount}`;
          out.push(assistant([{ type: "tool_use", id, name: tool, input: {} }]));
        }
        out.push(toolResult(id, str(ev.preview) ?? "", ev.error === true));
        return out;
      }
      case "subagent.start": {
        const id = str(ev.subagent_id) ?? `${this.idPrefix}-subagent-${++this.toolCount}`;
        const goal = str(ev.goal) ?? str(ev.preview) ?? "";
        const input = { description: goal };
        for (const key of ["preview", "model", "task_index", "task_count", "depth"]) {
          if (ev[key] !== void 0 && ev[key] !== null) input[key] = ev[key];
        }
        return [...this.flush(), assistant([{ type: "tool_use", id, name: SUBAGENT_TOOL, input, ...goal ? { title: goal } : {} }])];
      }
      case "subagent.complete": {
        const id = str(ev.subagent_id);
        if (!id) return [];
        const status = str(ev.status) ?? "completed";
        const summary = str(ev.summary) ?? status;
        return [...this.flush(), toolResult(id, summary, status !== "completed")];
      }
      default:
        return [];
    }
  }
  /** The turn's last lines: the remaining answer, then the `result`. */
  finish(end) {
    if (this.ended) return [];
    this.ended = true;
    const out = [];
    if (end.kind === "completed") {
      const final = (end.output ?? "") || this.buffer || (this.lastText ? "" : this.fallbackText);
      this.buffer = "";
      out.push(...this.text(final));
    } else if (end.kind === "interrupted" && !this.buffer && !this.lastText && end.partial) {
      out.push(...this.text(end.partial));
    } else {
      out.push(...this.flush());
    }
    const failed = end.kind === "failed" || end.kind === "interrupted";
    const u = end.kind === "completed" ? usage(end.usage) : null;
    out.push({
      type: "result",
      payload: {
        type: "result",
        subtype: failed ? "error" : end.kind === "cancelled" ? "cancelled" : "success",
        is_error: failed,
        ...failed ? { error: end.message } : {},
        ...this.lastText ? { result: this.lastText } : {},
        stop_reason: end.kind === "completed" ? "end_turn" : end.kind === "cancelled" ? "cancelled" : end.kind === "interrupted" ? "interrupted" : "error",
        total_cost_usd: 0,
        ...u ? { usage: u } : {}
      }
    });
    return out;
  }
  /** The buffered answer as one persisted message. `replace` is what the agent
   *  said it streamed, when the buffer missed it (a resumed stream). */
  flush(replace) {
    const text = this.buffer || replace || "";
    this.buffer = "";
    return this.text(text);
  }
  text(text) {
    if (!text.trim()) return [];
    this.lastText = text;
    return [assistant([{ type: "text", text }])];
  }
};

// src/sse.ts
async function* readSse(body) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let pending = "";
  let id = null;
  let data = [];
  let sawField = false;
  try {
    for (; ; ) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = pending.search(/\r\n|\r|\n/);
      while (newline !== -1 && (done || newline < pending.length - 1 || pending[newline] !== "\r")) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + (pending.startsWith("\r\n", newline) ? 2 : 1));
        if (line === "") {
          if (sawField && data.length > 0) yield { kind: "data", id, data: data.join("\n") };
          id = null;
          data = [];
          sawField = false;
        } else if (line.startsWith(":")) {
          yield { kind: "comment", text: line.slice(1).trim() };
        } else {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value2 = colon === -1 ? "" : line.slice(colon + 1);
          if (value2.startsWith(" ")) value2 = value2.slice(1);
          if (field === "data") {
            data.push(value2);
            sawField = true;
          } else if (field === "id") {
            id = value2;
            sawField = true;
          }
        }
        newline = pending.search(/\r\n|\r|\n/);
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

// src/driver.ts
var DIALECT_ID = "hermes-gateway";
var PROFILE_ID = "hermes-gateway";
var DEFAULT_TIMING = {
  watchdogMs: 12e4,
  deadSocketMs: 75e3,
  tickMs: 1e3,
  pollMs: 2e3,
  unreachableBudgetMs: 18e4,
  admitAttempts: 5,
  rateLimitBudgetMs: 12e4,
  cancelGraceMs: 15e3,
  saveThrottleMs: 500
};
var CAPABILITIES = Object.freeze({ loadSession: false, resume: true, mcp: false, image: false });
var INTERRUPTED = "The Hermes gateway restarted and interrupted this answer. The conversation is kept: send your message again to continue.";
var LOST_ADMISSION = "Rooks restarted while your message was being sent to Hermes, and cannot tell whether it arrived. Send it again.";
var RUN_GONE = "The Hermes gateway no longer knows the run of this answer (it expired, or the gateway lost it). Send your message again.";
function str2(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function record4(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function readable(err) {
  if (err instanceof UserFacingError || err instanceof GatewayError || err instanceof GatewayUnreachableError) return err.message;
  return "The Hermes gateway session failed.";
}
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
function hermesError(value) {
  const text = typeof value === "string" ? value : str2(record4(value)?.message);
  const flat = text?.replace(/\s+/g, " ").trim();
  return flat ? `The Hermes run failed: ${flat.length > 300 ? `${flat.slice(0, 300)}\u2026` : flat}` : "The Hermes run failed.";
}
function initEvent(sessionId, backend, model) {
  return {
    type: "system",
    payload: { type: "system", subtype: "init", session_id: sessionId, backend, ...model ? { model } : {}, mcp_servers: [], tools: [] }
  };
}
function extractSessionId(ev) {
  if (ev.type !== "system") return null;
  const payload = record4(ev.payload);
  if (!payload || payload.subtype !== "init") return null;
  return str2(payload.session_id);
}
var HermesDriver = class {
  constructor(args, deps) {
    this.args = args;
    this.deps = deps;
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
  }
  args;
  deps;
  timing;
  target = null;
  sessionId = null;
  current = null;
  closed = false;
  turn = null;
  /** Decided on the first frame of the first stream, then kept. */
  mode = "unknown";
  lastSave = 0;
  get info() {
    return this.current;
  }
  /* ── Lifecycle ────────────────────────────────────────────────────────── */
  async start() {
    if (this.closed) throw new Error("the session is closed");
    if (this.current) return this.current;
    const model = this.args.spawn.cfg.model ?? null;
    let target;
    try {
      target = await this.deps.resolveTarget(this.args.launch, model);
      const { body } = await call(this.deps.fetch, target, "GET", "v1/capabilities");
      const missing = missingFeatures(body);
      if (missing.length > 0) throw new UserFacingError(versionTooOld(missing));
    } catch (err) {
      throw new Error(readable(err));
    }
    if (this.closed) throw new Error("the session is closed");
    this.target = target;
    if (this.args.resume) return this.reattach(this.args.resume);
    const asked = this.args.spawn.resumeSession;
    const sessionId = asked ?? `rooks-${randomUUID2()}`;
    const resumed = asked ? await this.sessionKnown(asked) : false;
    if (this.closed) throw new Error("the session is closed");
    this.sessionId = sessionId;
    this.current = { sessionId, capabilities: CAPABILITIES, resumed };
    this.emit(initEvent(sessionId, this.args.profileId, model));
    this.save(true);
    return this.current;
  }
  prompt(text, images) {
    if (this.closed) return Promise.reject(new Error("the session is closed"));
    if (!this.current || !this.target) return Promise.reject(new Error("the session is not started"));
    if (this.turn && !this.turn.done) return Promise.reject(new Error("a turn is already running"));
    return new Promise((resolve, reject) => {
      const turn = this.newTurn(null, -1);
      turn.settle = { resolve, reject };
      this.turn = turn;
      if (images && images.length > 0) {
        this.emit({
          type: "assistant",
          payload: { type: "assistant", message: { id: randomUUID2(), role: "assistant", content: [{ type: "text", text: `(${images.length} image(s) not sent: a Hermes gateway agent receives text only.)` }] } }
        });
      }
      void this.runTurn(turn, text);
    });
  }
  /** `POST /v1/runs/{id}/steer`: the instruction reaches the run that is going on. */
  async steer(text) {
    const turn = this.turn;
    if (!turn || turn.done || !turn.runId || !this.target || this.closed) return false;
    try {
      await call(this.deps.fetch, this.target, "POST", `v1/runs/${encodeURIComponent(turn.runId)}/steer`, { body: { input: text } });
      return true;
    } catch (err) {
      if (err instanceof GatewayError && err.status === 409) return false;
      throw err;
    }
  }
  async cancel() {
    const turn = this.turn;
    if (!turn || turn.done) return;
    turn.cancelRequested = true;
    turn.wake.abort();
    const grace = setTimeout(() => {
      if (!turn.done) this.finishTurn(turn, { kind: "cancelled" });
    }, this.timing.cancelGraceMs);
    grace.unref?.();
    if (turn.runId) await this.stopRun(turn.runId);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    const turn = this.turn;
    if (!turn || turn.done) return;
    turn.done = true;
    turn.abort.abort();
    turn.wake.abort();
    if (turn.runId) void this.stopRun(turn.runId);
    const settle = turn.settle;
    turn.settle = null;
    settle?.reject(new Error("the session was closed"));
  }
  /* ── After a daemon restart ───────────────────────────────────────────── */
  async reattach(resume) {
    const state = resume.state;
    const sessionId = str2(state.sessionId);
    if (!sessionId) throw new Error("The saved position of this Hermes conversation is unreadable.");
    const runId = str2(state.runId);
    const lastSeq = typeof state.lastSeq === "number" && Number.isInteger(state.lastSeq) ? state.lastSeq : -1;
    this.sessionId = sessionId;
    this.current = { sessionId, capabilities: CAPABILITIES, resumed: true };
    if (!resume.turnActive) {
      this.save(true);
      return this.current;
    }
    const turn = this.newTurn(runId, lastSeq);
    this.turn = turn;
    if (!runId) {
      this.finishTurn(turn, { kind: "failed", message: LOST_ADMISSION });
      return this.current;
    }
    let status;
    try {
      status = (await call(this.deps.fetch, this.target, "GET", `v1/runs/${encodeURIComponent(runId)}`)).body;
    } catch (err) {
      turn.done = true;
      if (err instanceof GatewayError && err.status === 404) throw new Error(RUN_GONE);
      throw new Error(readable(err));
    }
    void this.follow(turn, status).catch((err) => this.finishTurn(turn, { kind: "failed", message: readable(err) }));
    return this.current;
  }
  /* ── One turn ─────────────────────────────────────────────────────────── */
  newTurn(runId, lastSeq) {
    return {
      runId,
      idempotencyKey: `rooks-${randomUUID2()}`,
      mapper: new TurnMapper(`hermes-${randomUUID2().slice(0, 8)}`),
      lastSeq,
      settle: null,
      abort: new AbortController(),
      wake: new AbortController(),
      cancelRequested: false,
      done: false,
      streamGone: false,
      approvals: /* @__PURE__ */ new Set()
    };
  }
  async runTurn(turn, text) {
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
  async admit(turn, text) {
    const target = this.target;
    const systemPrompt = this.args.spawn.systemPrompt;
    const body = { input: text, session_id: this.sessionId, ...systemPrompt ? { instructions: systemPrompt } : {} };
    const started = Date.now();
    let attempt = 0;
    for (; ; ) {
      if (turn.done) return null;
      if (turn.cancelRequested) {
        this.finishTurn(turn, { kind: "cancelled" });
        return null;
      }
      try {
        const { body: answer } = await call(this.deps.fetch, target, "POST", "v1/runs", {
          body,
          signal: turn.abort.signal,
          extraHeaders: { "idempotency-key": turn.idempotencyKey }
        });
        const runId = str2(answer.run_id);
        if (!runId) throw new GatewayError("The Hermes gateway accepted the message without naming its run.", 502, null);
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
            this.finishTurn(turn, { kind: "failed", message: err.message });
            return null;
          }
          turn.wake = new AbortController();
          await sleep(err.retryAfterMs ?? 1e3, turn.wake.signal);
          continue;
        }
        const transient = err instanceof GatewayUnreachableError || err instanceof GatewayError && err.status >= 500;
        if (transient && ++attempt < this.timing.admitAttempts) {
          turn.wake = new AbortController();
          await sleep(Math.min(this.timing.pollMs * 2 ** (attempt - 1), 3e4), turn.wake.signal);
          continue;
        }
        if (err instanceof GatewayError) {
          this.finishTurn(turn, { kind: "failed", message: err.message });
          return null;
        }
        throw err;
      }
    }
  }
  /** Reads the run to its end: stream first, status when the stream fails. */
  async follow(turn, initial) {
    if (initial && await this.settleFromStatus(turn, initial)) return;
    let unreachableSince = null;
    let notFound = 0;
    while (!turn.done && !this.closed) {
      if (!turn.streamGone) {
        const outcome = await this.stream(turn);
        if (turn.done || this.closed) return;
        if (outcome !== "unreachable" && this.mode !== "replay") turn.streamGone = true;
      }
      try {
        const { body } = await call(this.deps.fetch, this.target, "GET", `v1/runs/${encodeURIComponent(turn.runId)}`, { signal: turn.abort.signal });
        unreachableSince = null;
        notFound = 0;
        if (await this.settleFromStatus(turn, body)) return;
      } catch (err) {
        if (turn.done || turn.abort.signal.aborted) return;
        if (err instanceof GatewayError && err.status === 404) {
          if (++notFound >= 2) {
            this.finishTurn(turn, { kind: "failed", message: RUN_GONE });
            return;
          }
          continue;
        }
        if (err instanceof GatewayError && (err.status === 401 || err.status === 403)) {
          this.finishTurn(turn, { kind: "failed", message: err.message });
          return;
        }
        unreachableSince ??= Date.now();
        if (Date.now() - unreachableSince >= this.timing.unreachableBudgetMs) {
          throw new GatewayUnreachableError("Rooks lost contact with the Hermes gateway during this answer. Hermes keeps the conversation: send a message to continue once it is back.");
        }
      }
      await sleep(this.timing.pollMs, turn.abort.signal);
    }
  }
  /** One read of the event stream. Never throws. */
  async stream(turn) {
    const target = this.target;
    const controller = new AbortController();
    const relay = () => controller.abort();
    turn.abort.signal.addEventListener("abort", relay, { once: true });
    const resumeFrom = this.mode === "replay" && turn.lastSeq >= 0 ? { "last-event-id": String(turn.lastSeq) } : {};
    let timer = null;
    try {
      let response;
      try {
        response = await send(this.deps.fetch, joinUrl(target.base, `v1/runs/${encodeURIComponent(turn.runId)}/events`), {
          method: "GET",
          headers: headers(target, { accept: "text/event-stream", "accept-encoding": "identity", ...resumeFrom }),
          signal: controller.signal,
          redirect: "error"
        });
      } catch {
        return controller.signal.aborted ? "aborted" : "unreachable";
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => void 0);
        if (response.status === 404) return "gone";
        return "unreachable";
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
        if (frame.kind === "comment") continue;
        if (this.mode === "unknown") this.mode = frame.id !== null ? "replay" : "degraded";
        const ev = parseEvent(frame.data);
        if (!ev) continue;
        const seq = frame.id !== null && /^\d+$/.test(frame.id) ? Number(frame.id) : null;
        if (seq !== null && seq <= turn.lastSeq) continue;
        lastEvent = Date.now();
        this.handle(turn, ev);
        if (turn.done) return "terminal";
        if (seq !== null) turn.lastSeq = seq;
        this.save(ev.event !== "message.delta");
      }
      return "eof";
    } catch {
      return controller.signal.aborted ? "aborted" : "unreachable";
    } finally {
      if (timer) clearInterval(timer);
      turn.abort.signal.removeEventListener("abort", relay);
      controller.abort();
    }
  }
  /** The stream went quiet: the status says whether the run is still on. */
  async watchdog(turn, stream) {
    try {
      const { body } = await call(this.deps.fetch, this.target, "GET", `v1/runs/${encodeURIComponent(turn.runId)}`, { signal: turn.abort.signal });
      if (await this.settleFromStatus(turn, body)) stream.abort();
    } catch {
    }
  }
  handle(turn, ev) {
    switch (ev.event) {
      case "approval.request":
        void this.approval(turn, ev);
        return;
      case "approval.responded": {
        const id = str2(ev.request_id);
        if (id) turn.approvals.add(id);
        return;
      }
      case "run.completed":
        this.finishTurn(turn, { kind: "completed", output: str2(ev.output), usage: ev.usage });
        return;
      case "run.cancelled":
        this.finishTurn(turn, { kind: "cancelled" });
        return;
      case "run.failed":
        this.finishTurn(turn, { kind: "failed", message: hermesError(ev.error) });
        return;
      case "run.interrupted":
        void this.interrupted(turn);
        return;
      default:
        this.emitAll(turn.mapper.map(ev));
    }
  }
  /** True when the status ends the turn. */
  async settleFromStatus(turn, status) {
    if (turn.done) return true;
    switch (str2(status.status)) {
      case "completed":
        this.finishTurn(turn, { kind: "completed", output: str2(status.output), usage: status.usage });
        return true;
      case "cancelled":
        this.finishTurn(turn, { kind: "cancelled" });
        return true;
      case "failed":
        this.finishTurn(turn, { kind: "failed", message: hermesError(status.error) });
        return true;
      case "interrupted":
        await this.interrupted(turn);
        return true;
      case "waiting_for_approval": {
        const approval = record4(status.approval);
        if (approval) void this.approval(turn, approval);
        return false;
      }
      default:
        if (status.shutdown_requested_at) this.deps.log?.info("hermes gateway is shutting down under a running turn");
        return false;
    }
  }
  async interrupted(turn) {
    if (turn.done) return;
    const partial = await this.partialText();
    this.finishTurn(turn, { kind: "interrupted", message: INTERRUPTED, partial });
  }
  /** What Hermes kept of an interrupted answer: the assistant messages after
   *  the last user message of the session. */
  async partialText() {
    if (!this.target || !this.sessionId) return null;
    try {
      const { body } = await call(this.deps.fetch, this.target, "GET", `api/sessions/${encodeURIComponent(this.sessionId)}/messages`);
      const list = [body.messages, body.data, body.items].find(Array.isArray);
      if (!list) return null;
      let lastUser = -1;
      list.forEach((m, i) => {
        if (record4(m)?.role === "user") lastUser = i;
      });
      const texts = list.slice(lastUser + 1).map(record4).filter((m) => m?.role === "assistant").map((m) => typeof m.content === "string" ? m.content : "").filter((t) => t.trim());
      return texts.length > 0 ? texts.join("\n\n") : null;
    } catch {
      return null;
    }
  }
  /** `approval.request` → the product's Allow/Deny card → `once` or `deny`. */
  async approval(turn, payload) {
    const id = str2(payload.request_id);
    if (!id || turn.approvals.has(id) || turn.done || this.closed) return;
    turn.approvals.add(id);
    const command = str2(payload.command);
    const description = str2(payload.description);
    const request = {
      toolCallId: id,
      tool: turn.mapper.lastTool ?? "terminal",
      title: description ?? command,
      input: {
        ...command ? { command } : {},
        ...description ? { description } : {},
        ...Array.isArray(payload.pattern_keys) ? { pattern_keys: payload.pattern_keys } : {}
      },
      // Hermes remembers a choice for the session or for good: the card offers both.
      scopes: ["session", "always"]
    };
    let allow = false;
    let scope;
    try {
      const decision = await this.args.host.requestPermission(request);
      allow = decision.allow;
      scope = decision.scope;
    } catch {
      allow = false;
    }
    if (turn.done || this.closed || !turn.runId) return;
    try {
      await call(this.deps.fetch, this.target, "POST", `v1/runs/${encodeURIComponent(turn.runId)}/approval`, {
        body: { choice: allow ? scope ?? "once" : "deny", request_id: id }
      });
    } catch (err) {
      if (!(err instanceof GatewayError && err.status === 409)) this.deps.log?.warn(`hermes approval answer failed: ${readable(err)}`);
    }
  }
  async stopRun(runId) {
    if (!this.target) return;
    try {
      await call(this.deps.fetch, this.target, "POST", `v1/runs/${encodeURIComponent(runId)}/stop`);
    } catch (err) {
      this.deps.log?.warn(`hermes stop failed: ${readable(err)}`);
    }
  }
  /** Does Hermes still hold this session? Unknown counts as yes. */
  async sessionKnown(sessionId) {
    try {
      await call(this.deps.fetch, this.target, "GET", `api/sessions/${encodeURIComponent(sessionId)}`);
      return true;
    } catch (err) {
      return !(err instanceof GatewayError && err.status === 404);
    }
  }
  finishTurn(turn, end) {
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
    const stopReason = end.kind === "completed" ? "end_turn" : end.kind === "cancelled" ? "cancelled" : end.kind === "interrupted" ? "interrupted" : "error";
    settle?.resolve({ stopReason });
  }
  /* ── Out ──────────────────────────────────────────────────────────────── */
  emit(ev) {
    if (!this.closed) this.args.host.emit(ev);
  }
  emitAll(events) {
    for (const ev of events) this.emit(ev);
  }
  /** `{ runId, sessionId, lastSeq }` and nothing else: never the key, never the URL. */
  save(force) {
    if (this.closed || !this.sessionId) return;
    const now = Date.now();
    if (!force && now - this.lastSave < this.timing.saveThrottleMs) return;
    this.lastSave = now;
    const turn = this.turn && !this.turn.done ? this.turn : null;
    try {
      this.args.host.saveResume({ runId: turn?.runId ?? null, sessionId: this.sessionId, lastSeq: turn?.lastSeq ?? -1 });
    } catch (err) {
      this.deps.log?.warn(`hermes resume state refused: ${err instanceof Error ? err.name : "error"}`);
    }
  }
};
function createHermesDialect(deps) {
  return {
    id: DIALECT_ID,
    transport: "remote",
    sessionResumable: true,
    sessionStore: "global",
    permissionModel: "protocol",
    rateLimitReporting: "none",
    hostedConnectors: false,
    // The agent works on the gateway's machine (no Rooks folder), takes its
    // MCP servers from its own config.yaml, and /v1/runs drops files silently.
    capabilities: { worktree: false, rooksMcp: false, attachments: false, rooksPreamble: false },
    openSession: (args) => new HermesDriver(args, deps),
    extractSessionId
  };
}

// src/agents.ts
function profileSlug(profile) {
  return profile.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+/, "") || "default";
}
var MAX_NAME = 100;
function labelSlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 40).replace(/[-_]+$/, "");
}
function agentNameFor(profile) {
  return `hermes.${profileSlug(profile)}`;
}
function connectionAgentName(connection, withId = false) {
  const profile = profileSlug(connectionProfile(connection));
  const id = labelSlug(connection.id).slice(0, 8);
  const room = MAX_NAME - "hermes.".length - 1 - profile.length - (withId ? id.length + 1 : 0);
  const label = labelSlug(connection.label).slice(0, Math.max(0, room)).replace(/[-_]+$/, "");
  const middle = withId || !label ? [label, id].filter(Boolean).join("-") : label;
  return `hermes.${middle}.${profile}`;
}
function promptFor(profile) {
  return `You are the Hermes agent of the profile "${profile}", reached through the user's Hermes gateway. You work on the gateway's machine with your own tools; you do not see Rooks's files.`;
}
async function syncAgents(ctx, connections) {
  const agents = await ctx.agents.list();
  const known = new Map(agents.map((a) => [a.name.toLowerCase(), a]));
  const report = { created: [], updated: [], kept: [], skipped: [] };
  const live = connections.filter(usable);
  const callerIds = new Set(connections.map((c) => c.id));
  const pinnedTo = (agent) => agent.backend === PROFILE_ID ? parseModel(agent.model)?.connectionId ?? null : null;
  const door = (agent) => {
    const pinned = pinnedTo(agent);
    return !pinned || callerIds.has(pinned);
  };
  async function place(name2, model, profile, mayRepoint) {
    const fields = { systemPrompt: promptFor(profile), role: "research", backend: PROFILE_ID, model };
    const existing = known.get(name2.toLowerCase());
    if (!existing) {
      const created = await ctx.agents.create({ name: name2, ...fields });
      known.set(name2.toLowerCase(), created);
      report.created.push(name2);
    } else if (existing.mine && existing.backend === fields.backend && existing.model === fields.model) {
      report.kept.push(existing.name);
    } else if (existing.mine && mayRepoint(existing)) {
      await ctx.agents.update(existing.name, { backend: fields.backend, model: fields.model });
      report.updated.push(existing.name);
    } else {
      return "taken";
    }
    return "done";
  }
  const byProfile = /* @__PURE__ */ new Map();
  for (const connection of live) {
    const profile = connectionProfile(connection);
    byProfile.set(profile, [...byProfile.get(profile) ?? [], connection]);
  }
  for (const [profile, served] of byProfile) {
    if (served.length === 1) {
      const name2 = agentNameFor(profile);
      if (await place(name2, modelOfProfile(profile), profile, door) === "taken") report.skipped.push(known.get(name2.toLowerCase())?.name ?? name2);
      continue;
    }
    for (const connection of served) {
      const model = modelOfConnection(connection);
      const already = agents.find((a) => a.mine && a.backend === PROFILE_ID && a.model === model);
      if (already) {
        report.kept.push(already.name);
        continue;
      }
      const same = (agent) => pinnedTo(agent) === connection.id;
      if (await place(connectionAgentName(connection), model, profile, same) === "done") continue;
      const fallback = connectionAgentName(connection, true);
      if (await place(fallback, model, profile, same) === "taken") report.skipped.push(known.get(fallback.toLowerCase())?.name ?? fallback);
    }
  }
  return report;
}

// src/index.ts
var name = "hermes-gateway";
var AGENT_ERROR_STATUS = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409 };
function apply(ctx) {
  const typeId = qualifiedType(ctx.id);
  const outbound = ctx.fetch;
  if (!outbound) throw new Error("hermes-gateway needs the http:outbound permission");
  const fetch = (input, init) => outbound(input, init);
  ctx.backends.registerDialect(DIALECT_ID, createHermesDialect({
    fetch,
    resolveTarget: (launch, model) => resolveTarget(ctx.connections, typeId, launch, model),
    log: { info: (m) => ctx.log.info(m), warn: (m) => ctx.log.warn(m) }
  }));
  ctx.backends.registerProfile({
    id: PROFILE_ID,
    dialect: DIALECT_ID,
    label: "Hermes Gateway",
    vendor: "Nous Research",
    custom: true,
    // The gateway and its key belong to the account that launches the
    // mission and depend on the agent's profile: the driver resolves them in
    // start(), where a missing connection is told to that user only. Visibility
    // is global, so nothing here may depend on a user.
    env: () => ({}),
    defaultModel: "hermes/default",
    models: [{ slug: "hermes/default", label: "Hermes \u2014 default profile" }],
    slugPrefixes: ["hermes/"],
    subscription: { note: "Runs on your own Hermes gateway: its models, its tools, its key (Settings \u203A Secrets \u203A Connections)." }
  });
  ctx.connections.registerType(connectionType());
  const router = ctx.router();
  router.get("/status", (_req, res, next) => {
    const user = ctx.user();
    if (!user) {
      res.status(401).json({ error: "sign in" });
      return;
    }
    (async () => {
      const mine = (await ctx.connections.forUser(user.id)).filter((c) => c.type === typeId);
      const served = await agentsByConnection(mine);
      const connections = await Promise.all(mine.map(async (c) => ({ ...await statusOf(c, user.id), agents: served.get(c.id) ?? [] })));
      res.json({ connections });
    })().catch(next);
  });
  router.post("/agents", (_req, res) => {
    const user = ctx.user();
    if (!user) {
      res.status(401).json({ error: "sign in" });
      return;
    }
    (async () => {
      const mine = (await ctx.connections.forUser(user.id)).filter((c) => c.type === typeId);
      if (!mine.some(usable)) {
        res.status(409).json({ error: "Add an approved Hermes gateway connection first.", code: "no_connection" });
        return;
      }
      res.json(await syncAgents(ctx, mine));
    })().catch((err) => {
      const code = err !== null && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : null;
      const message = err instanceof Error ? err.message : "agents could not be created";
      res.status(code ? AGENT_ERROR_STATUS[code] ?? 403 : 403).json({ error: message, code });
    });
  });
  async function agentsByConnection(mine) {
    const served = /* @__PURE__ */ new Map();
    let agents;
    try {
      agents = await ctx.agents.list();
    } catch {
      return served;
    }
    for (const agent of agents) {
      if (agent.backend !== PROFILE_ID) continue;
      let target;
      try {
        target = pickConnection(mine, agent.model);
      } catch {
        continue;
      }
      served.set(target.id, [...served.get(target.id) ?? [], agent.name]);
    }
    return served;
  }
  async function statusOf(connection, owner) {
    const profile = connectionProfile(connection);
    const base = {
      id: connection.id,
      label: connection.label,
      profile,
      origin: new URL(connection.url).origin,
      approval: connection.approval,
      enabled: connection.enabled,
      version: null,
      message: null
    };
    if (connection.approval === "rejected") return { ...base, state: "error", message: "An administrator refused this address." };
    if (connection.approval !== "approved") return { ...base, state: "pending" };
    if (!connection.enabled) return { ...base, state: "off" };
    const key = await ctx.connections.userSecret(owner, connection.id, SECRET_KEY);
    if (!key) return { ...base, state: "error", message: "No API key is set for this connection." };
    const { root, base: profileBase } = targetUrls(connection.url, profile);
    const check = await checkGateway(fetch, { root, base: profileBase, profile, key, sessionKey: null }, AbortSignal.timeout(1e4));
    return check.ok ? { ...base, state: "ok", version: check.version } : { ...base, state: "error", message: check.message };
  }
}
export {
  agentNameFor,
  apply,
  connectionAgentName,
  connectionType,
  createHermesDialect,
  name,
  parseModel,
  resolveTarget,
  syncAgents
};
