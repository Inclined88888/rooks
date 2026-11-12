/**
 * The host half of the MCP Apps bridge (spec `2026-01-26`, ADR-MCPUI D5).
 *
 * No transport: `post` sends, `receive` takes what arrived. The card wires
 * them to `iframe.contentWindow.postMessage` and to the window's `message`
 * event after checking `event.source` and `event.origin` itself; this module
 * never touches the DOM, so it is tested without one.
 *
 * What the document sends is untrusted — its HTML is written by an agent.
 * Every message is checked by hand-written guards (D5: `app/` has no zod),
 * anything unexpected is ignored, and a request for a method the host does
 * not serve gets `-32601`. `hostCapabilities` declares what the card serves,
 * nothing more: `tools/call` of the one tool `submit`, `ui/message` (text),
 * `ui/open-link`, and the display modes it offers. What those do — ask the
 * owner, check the focus — is the card's business, through the callbacks.
 * At most 8 requests wait for the card at once: the next one is refused,
 * never queued.
 */

import { clampDocumentHeight } from './ui-documents';

export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_IN_FLIGHT = 8;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const TOO_MANY_REQUESTS = -32000;
/** The one tool a Rooks document may call (D5): its answer. */
export const SUBMIT_TOOL = 'submit';
export const TEARDOWN_WAIT_MS = 2000;
const MAX_MESSAGE_TEXT = 4000;
const MAX_URL_CHARS = 2048;

export type DisplayMode = 'inline' | 'fullscreen';

export type McpAppHostContext = {
  theme: 'light' | 'dark';
  styles: { variables: Record<string, string> };
  displayMode: DisplayMode;
  availableDisplayModes: readonly DisplayMode[];
  /** The card's width is the thread's: fixed, not a maximum (spec: width or maxWidth). */
  containerDimensions: { width: number; maxHeight: number };
  platform: 'web' | 'desktop';
  locale: string;
  timeZone: string;
  deviceCapabilities: { touch: boolean; hover: boolean };
};

type JsonRpcId = string | number;
export type JsonRpcOut =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: Record<string, unknown> }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string } }
  | { jsonrpc: '2.0'; method: string; params: Record<string, unknown> }
  | { jsonrpc: '2.0'; id: JsonRpcId; method: string; params: Record<string, unknown> };

/** What the card made of a `submit`: sent, or refused with a reason the document may show. */
export type SubmitOutcome = { ok: true } | { ok: false; reason: string };

export type McpAppHostOptions = {
  post(message: JsonRpcOut): void;
  context(): McpAppHostContext;
  onSizeChanged(height: number): void;
  onInitialized?(): void;
  hostVersion?: string;
  /** `tools/call` of `submit`, its arguments an object. Absent: the tool is not served. */
  onSubmit?(value: Record<string, unknown>): Promise<SubmitOutcome>;
  /** `ui/message`, its text blocks joined. True once sent; false when refused or cancelled. */
  onMessage?(text: string): Promise<boolean>;
  /** `ui/open-link`, an `https:` URL already checked. True once opened. */
  onOpenLink?(url: string): Promise<boolean>;
  /** `ui/request-display-mode`: the mode actually set. */
  onDisplayMode?(mode: DisplayMode | 'pip'): Promise<DisplayMode>;
  /** `ui/notifications/request-teardown`: the document asks to be closed. */
  onRequestTeardown?(): void;
};

export type McpAppHost = {
  receive(data: unknown): void;
  /** Sends the fields that changed since the last context the document got. */
  updateContext(next: McpAppHostContext): void;
  /** `ui/resource-teardown`: resolves on the document's answer, or after 2 s, or at once without a handshake. */
  teardown(): Promise<void>;
  /** The document left its page (second `load`) or the card unmounts: nothing more is sent. */
  close(): void;
  readonly initialized: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Size of a message as JSON, or null when it cannot be one (a cycle, a BigInt). */
function jsonBytes(value: unknown): number | null {
  let text: string;
  try { text = JSON.stringify(value); } catch { return null; }
  if (typeof text !== 'string') return null;
  // UTF-8 upper bound without allocating: 3 bytes per UTF-16 unit at most.
  return text.length * 3 <= MAX_MESSAGE_BYTES ? text.length : new TextEncoder().encode(text).length;
}

/** An `https:` URL a browser can open, or null. */
export function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_CHARS) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** The text of a `ui/message` (text blocks only, D5), or null for anything else. */
export function messageText(params: Record<string, unknown> | null): string | null {
  if (!params || params.role !== 'user' || !Array.isArray(params.content)) return null;
  const blocks = params.content as unknown[];
  if (blocks.length === 0 || blocks.length > 16) return null;
  const parts: string[] = [];
  for (const raw of blocks) {
    const block = record(raw);
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return null;
    parts.push(block.text);
  }
  const text = parts.join('\n').trim();
  return text && text.length <= MAX_MESSAGE_TEXT ? text : null;
}

function validId(value: unknown): value is JsonRpcId {
  return (typeof value === 'string' && value.length > 0 && value.length <= 128)
    || (typeof value === 'number' && Number.isSafeInteger(value));
}

export function createMcpAppHost(options: McpAppHostOptions): McpAppHost {
  let closed = false;
  let initialized = false;
  let answeredInitialize = false;
  let sent: McpAppHostContext | null = null;
  let inFlight = 0;
  let nextOutId = 1;
  const awaiting = new Map<JsonRpcId, () => void>();

  const post = (message: JsonRpcOut): void => {
    if (!closed) options.post(message);
  };

  const respond = (id: JsonRpcId, result: Record<string, unknown>): void => post({ jsonrpc: '2.0', id, result });
  const fail = (id: JsonRpcId, code: number, message: string): void => post({ jsonrpc: '2.0', id, error: { code, message } });

  function capabilities(): Record<string, unknown> {
    return {
      ...(options.onOpenLink ? { openLinks: {} } : {}),
      ...(options.onSubmit ? { serverTools: {} } : {}),
      ...(options.onMessage ? { message: { text: {} } } : {}),
    };
  }

  /** A request the card answers later: counted, answered once, dropped if the bridge closed meanwhile. */
  function later(id: JsonRpcId, work: () => Promise<Record<string, unknown>>, onError: () => Record<string, unknown>): void {
    if (inFlight >= MAX_IN_FLIGHT) { fail(id, TOO_MANY_REQUESTS, 'Too many requests in flight'); return; }
    inFlight += 1;
    let result: Promise<Record<string, unknown>>;
    try { result = work(); } catch { result = Promise.resolve(onError()); }
    void result.catch(() => onError()).then((value) => {
      inFlight -= 1;
      respond(id, value);
    });
  }

  const toolResult = (text: string, isError: boolean): Record<string, unknown> => ({
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : { structuredContent: { status: 'answered' } }),
  });

  function onRequest(id: JsonRpcId, method: string, params: Record<string, unknown> | null): void {
    if (method === 'ui/initialize') {
      sent = options.context();
      answeredInitialize = true;
      respond(id, {
        protocolVersion: MCP_APPS_PROTOCOL_VERSION,
        hostInfo: { name: 'rooks', version: options.hostVersion ?? '1' },
        hostCapabilities: capabilities(),
        hostContext: sent,
      });
      return;
    }
    if (method === 'ping') { respond(id, {}); return; }
    if (method === 'tools/call' && options.onSubmit) {
      const onSubmit = options.onSubmit;
      if (typeof params?.name !== 'string') { fail(id, INVALID_PARAMS, 'Invalid params'); return; }
      // Any other tool: the host serves none (plugin tools are deferred, ADR § 6).
      if (params.name !== SUBMIT_TOOL) { fail(id, METHOD_NOT_FOUND, `Unknown tool: ${params.name.slice(0, 64)}`); return; }
      const value = params.arguments === undefined ? {} : record(params.arguments);
      if (!value) { fail(id, INVALID_PARAMS, 'submit takes an object'); return; }
      later(id, async () => {
        const outcome = await onSubmit(value);
        return outcome.ok ? toolResult('The answer was sent.', false) : toolResult(outcome.reason, true);
      }, () => toolResult('The answer could not be sent.', true));
      return;
    }
    if (method === 'ui/message' && options.onMessage) {
      const onMessage = options.onMessage;
      const text = messageText(params);
      if (text === null) { fail(id, INVALID_PARAMS, 'ui/message takes text, at most 4000 characters'); return; }
      later(id, async () => (await onMessage(text) ? {} : { isError: true }), () => ({ isError: true }));
      return;
    }
    if (method === 'ui/open-link' && options.onOpenLink) {
      const onOpenLink = options.onOpenLink;
      if (typeof params?.url !== 'string') { fail(id, INVALID_PARAMS, 'Invalid params'); return; }
      const url = httpsUrl(params.url);
      // Refused by policy, not malformed: the spec's answer is `isError`.
      if (!url) { respond(id, { isError: true }); return; }
      later(id, async () => (await onOpenLink(url) ? {} : { isError: true }), () => ({ isError: true }));
      return;
    }
    if (method === 'ui/request-display-mode' && options.onDisplayMode) {
      const onDisplayMode = options.onDisplayMode;
      const mode = params?.mode;
      if (mode !== 'inline' && mode !== 'fullscreen' && mode !== 'pip') { fail(id, INVALID_PARAMS, 'Invalid params'); return; }
      const current = (): Record<string, unknown> => ({ mode: sent?.displayMode ?? 'inline' });
      later(id, async () => ({ mode: await onDisplayMode(mode) }), current);
      return;
    }
    fail(id, METHOD_NOT_FOUND, 'Method not found');
  }

  function onNotification(method: string, params: Record<string, unknown> | null): void {
    if (method === 'ui/notifications/initialized') {
      if (!answeredInitialize || initialized) return;
      initialized = true;
      options.onInitialized?.();
      return;
    }
    if (method === 'ui/notifications/size-changed') {
      const height = params?.height;
      if (typeof height !== 'number' || !Number.isFinite(height)) return;
      options.onSizeChanged(clampDocumentHeight(height));
      return;
    }
    if (method === 'ui/notifications/request-teardown') options.onRequestTeardown?.();
  }

  return {
    get initialized() { return initialized; },
    receive(data) {
      if (closed) return;
      const message = record(data);
      if (!message || message.jsonrpc !== '2.0') return;
      const bytes = jsonBytes(message);
      if (bytes === null || bytes > MAX_MESSAGE_BYTES) return;
      const { method, id } = message;
      if (method === undefined) {
        // A response: only to a request the host sent, and only once.
        if (!validId(id) || !('result' in message || 'error' in message)) return;
        const done = awaiting.get(id);
        if (done) { awaiting.delete(id); done(); }
        return;
      }
      if (typeof method !== 'string' || method.length > 128) return;
      if (message.params !== undefined && record(message.params) === null) return;
      const params = record(message.params);
      if (id !== undefined) {
        if (!validId(id)) return;
        onRequest(id, method, params);
      } else {
        onNotification(method, params);
      }
    },
    updateContext(next) {
      if (closed || !answeredInitialize || !sent) return;
      const changed = diffContext(sent, next);
      sent = next;
      if (Object.keys(changed).length) post({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: changed });
    },
    teardown() {
      if (closed || !answeredInitialize) return Promise.resolve();
      const id = `rooks-teardown-${nextOutId++}`;
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => { awaiting.delete(id); resolve(); }, TEARDOWN_WAIT_MS);
        awaiting.set(id, () => { clearTimeout(timer); resolve(); });
        post({ jsonrpc: '2.0', id, method: 'ui/resource-teardown', params: {} });
      });
    },
    close() {
      closed = true;
      for (const done of awaiting.values()) done();
      awaiting.clear();
    },
  };
}

/** The top-level fields of `next` that differ from `previous`, compared as JSON. */
export function diffContext(previous: McpAppHostContext, next: McpAppHostContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(next) as Array<keyof McpAppHostContext>) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) out[key] = next[key];
  }
  return out;
}

/**
 * Rooks's tokens under the spec's names (`McpUiStyleVariableKey`). A token
 * holding a bare HSL triplet (`220 12% 11%`, shadcn's form) is wrapped in
 * `hsl()`; anything that is not a plain value is dropped, since the document
 * sets it on its own root.
 */
const COLOR_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['--color-background-primary', '--background'],
  ['--color-background-secondary', '--card'],
  ['--color-background-tertiary', '--muted'],
  ['--color-background-inverse', '--foreground'],
  ['--color-background-ghost', '--accent'],
  ['--color-background-info', '--info'],
  ['--color-background-danger', '--destructive'],
  ['--color-background-success', '--success'],
  ['--color-background-warning', '--warning'],
  ['--color-text-primary', '--foreground'],
  ['--color-text-secondary', '--muted-foreground'],
  ['--color-text-inverse', '--background'],
  ['--color-text-info', '--info'],
  ['--color-text-danger', '--destructive'],
  ['--color-text-success', '--success'],
  ['--color-text-warning', '--warning'],
  ['--color-border-primary', '--border'],
  ['--color-border-secondary', '--input'],
  ['--color-border-danger', '--destructive'],
  ['--color-ring-primary', '--ring'],
];
const RAW_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['--font-sans', '--font-sans'],
  // code-font: the theme's code face, handed to the document for its own code blocks.
  ['--font-mono', '--font-mono'],
  ['--border-radius-md', '--radius'],
];

const HSL_TRIPLET = /^-?\d+(?:\.\d+)?(?:deg)?\s+-?\d+(?:\.\d+)?%\s+-?\d+(?:\.\d+)?%(?:\s*\/\s*[\d.]+%?)?$/;
const PLAIN_VALUE = /^[^;{}<>\\]{1,300}$/;

export function themeVariables(read: (token: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, token] of COLOR_TOKENS) {
    const value = read(token).trim();
    if (!value || !PLAIN_VALUE.test(value) || /url\(/i.test(value)) continue;
    out[name] = HSL_TRIPLET.test(value) ? `hsl(${value})` : value;
  }
  for (const [name, token] of RAW_TOKENS) {
    const value = read(token).trim();
    if (value && PLAIN_VALUE.test(value) && !/url\(/i.test(value)) out[name] = value;
  }
  return out;
}
