import { createHash } from 'node:crypto';

interface DiagnosticDebugger {
  attach(version?: string): void;
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown;
  on(event: 'detach', listener: () => void): unknown;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const id = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[\w.-]{1,100}$/.test(value) ? value : undefined;

/** Keep bundle locations, but never credentials, query strings or document routes. */
export function diagnosticUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return '[anonymous]';
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') return '[local-script]';
    if (!['http:', 'https:', 'chrome-extension:'].includes(url.protocol)) return `[${url.protocol}]`;
    const path = url.pathname.startsWith('/_next/static/') ? url.pathname : '/[redacted-path]';
    return `${url.origin}${path}`;
  } catch { return '[anonymous]'; }
}

function frames(value: unknown): unknown[] {
  const stack = object(value);
  return (Array.isArray(stack.callFrames) ? stack.callFrames : []).slice(0, 20).map((entry: unknown) => {
    const frame = object(entry);
    return { scriptId: id(frame.scriptId), url: diagnosticUrl(frame.url),
      line: number(frame.lineNumber), column: number(frame.columnNumber) };
  });
}

/** CDP sees parser failures and isolated-world preloads without replacing eval. */
export function startRendererDiagnostic(debuggerApi: DiagnosticDebugger, write: (line: string) => void): void {
  let remaining = 5000;
  let scripts = 1000;
  let sources = 30;
  const emit = (kind: string, fields: Record<string, unknown> = {}) => {
    if (remaining-- <= 0) return;
    try { write(JSON.stringify({ diagnostic: 'TIM-0011', time: Date.now(), kind, ...fields })); }
    catch { /* Diagnostic output must never prevent the window from loading. */ }
  };
  try { debuggerApi.attach('1.3'); }
  catch { emit('attach-failed'); return; }
  debuggerApi.on('detach', () => emit('detached'));
  debuggerApi.on('message', (_event, method, raw) => {
    if (remaining <= 0) return;
    const p = object(raw);
    if (method === 'Debugger.scriptParsed' || method === 'Debugger.scriptFailedToParse') {
      const failed = method === 'Debugger.scriptFailedToParse';
      if (!failed && scripts-- <= 0) return;
      const scriptId = id(p.scriptId);
      emit(failed ? 'script-failed' : 'script-parsed', {
        scriptId, url: diagnosticUrl(p.url), hash: id(p.hash), length: number(p.length),
        context: number(p.executionContextId), startLine: number(p.startLine), startColumn: number(p.startColumn),
        endLine: number(p.endLine), endColumn: number(p.endColumn), initiator: frames(p.stackTrace),
      });
      if (failed && scriptId && sources-- > 0) {
        void debuggerApi.sendCommand('Debugger.getScriptSource', { scriptId }).then((result) => {
          const source = object(result).scriptSource;
          if (typeof source !== 'string') { emit('source-unavailable', { scriptId }); return; }
          emit('failed-source', { scriptId, characters: source.length,
            sha256: createHash('sha256').update(source).digest('hex'),
            looksLikeHtml: /^\s*(?:<!doctype\s+html|<html\b)/i.test(source),
          });
        }).catch(() => emit('source-unavailable', { scriptId }));
      }
    } else if (method === 'Runtime.exceptionThrown') {
      const details = object(p.exceptionDetails);
      const exception = object(details.exception);
      // Descriptions can embed JSON payloads; locations and error class suffice.
      const errorClass = ['SyntaxError', 'TypeError', 'ReferenceError', 'RangeError', 'Error'].includes(String(exception.className))
        ? exception.className : 'Other';
      const description = typeof exception.description === 'string' ? exception.description : '';
      const category = description.includes('Unexpected end of JSON input') ? 'json-unexpected-end'
        : description.includes('Unexpected end of input') ? 'script-unexpected-end' : 'other';
      emit('exception', { errorClass, category, scriptId: id(details.scriptId), url: diagnosticUrl(details.url),
        context: number(details.executionContextId), line: number(details.lineNumber),
        column: number(details.columnNumber), stack: frames(details.stackTrace) });
    } else if (method === 'Runtime.executionContextCreated') {
      const context = object(p.context);
      emit('context', { context: number(context.id), origin: diagnosticUrl(context.origin),
        isDefault: object(context.auxData).isDefault === true });
    } else if (method === 'Network.responseReceived') {
      if (!['Script', 'Fetch', 'XHR', 'Document'].includes(String(p.type))) return;
      const response = object(p.response);
      const mime = typeof response.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(response.mimeType)
        ? response.mimeType : '[unknown]';
      emit('response', { requestId: id(p.requestId), type: p.type, url: diagnosticUrl(response.url),
        status: number(response.status), mime, encodedBytes: number(response.encodedDataLength) });
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      emit(method === 'Network.loadingFinished' ? 'response-finished' : 'response-failed', {
        requestId: id(p.requestId), encodedBytes: number(p.encodedDataLength) });
    }
  });
  // Queue before loadURL, but do not await: Electron may wait for navigation
  // before answering commands on a newly created WebContents.
  void Promise.all(['Runtime.enable', 'Debugger.enable', 'Network.enable'].map((method) =>
    debuggerApi.sendCommand(method))).then(() => emit('ready')).catch(() => emit('enable-failed'));
}
