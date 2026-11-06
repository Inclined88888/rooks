/** Console and network history for one tab, fed by CDP events once an agent asks for it. */

export const DEVTOOLS_MAX_ENTRIES = 500;
const TEXT_LIMIT = 4_000;
const URL_LIMIT = 2_048;
export const BODY_LIMIT = 100_000;
// Shared with the human: these carry sessions JavaScript cannot read (httpOnly cookies, bearer tokens).
const SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization']);

export interface ConsoleEntry {
  msgid: number; type: string; text: string; timestamp: number; url?: string; line?: number;
  args: string[]; stack: string[];
}
export interface NetworkEntry {
  reqid: number; requestId: string; method: string; url: string; resourceType: string; timestamp: number;
  requestHeaders: Record<string, string>; postData?: string;
  status?: number; statusText?: string; mimeType?: string; responseHeaders?: Record<string, string>;
  remoteAddress?: string; fromCache?: boolean; encodedDataLength?: number;
  state: 'pending' | 'finished' | 'failed'; errorText?: string;
}

type Params = Record<string, any>;

const clip = (value: unknown, limit: number): string => {
  const text = typeof value === 'string' ? value : value === undefined ? '' : String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

export function redactHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    out[name] = SECRET_HEADERS.has(name.toLowerCase()) ? '<redacted>' : clip(value, TEXT_LIMIT);
  }
  return out;
}

/** Renders a CDP RemoteObject the way the DevTools console line does, without a round trip. */
export function remoteObjectText(arg: Params | undefined): string {
  if (!arg) return '';
  if (arg.type === 'string') return clip(arg.value, TEXT_LIMIT);
  if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
  if (arg.type === 'undefined') return 'undefined';
  if ('value' in arg) {
    try { return clip(JSON.stringify(arg.value), TEXT_LIMIT); } catch { return clip(String(arg.value), TEXT_LIMIT); }
  }
  const preview = arg.preview as Params | undefined;
  if (preview && Array.isArray(preview.properties)) {
    const body = preview.properties.map((p: Params) => (preview.subtype === 'array' ? '' : `${p.name}: `) + (p.value ?? p.type)).join(', ');
    const [open, close] = preview.subtype === 'array' ? ['[', ']'] : ['{', '}'];
    return clip(`${arg.description && preview.subtype !== 'array' && arg.className !== 'Object' ? `${arg.className} ` : ''}${open}${body}${preview.overflow ? ', …' : ''}${close}`, TEXT_LIMIT);
  }
  return clip(arg.description ?? arg.className ?? arg.type, TEXT_LIMIT);
}

const stackOf = (trace: Params | undefined): string[] => (Array.isArray(trace?.callFrames) ? trace!.callFrames : [])
  .slice(0, 20).map((f: Params) => `${f.functionName || '(anonymous)'} ${clip(f.url, URL_LIMIT)}:${(f.lineNumber ?? 0) + 1}:${(f.columnNumber ?? 0) + 1}`);

function page<T>(items: T[], pageSize: unknown, pageIdx: unknown): { items: T[]; total: number; pageIdx: number; pages: number } {
  const size = Number.isInteger(pageSize) && (pageSize as number) > 0 ? Math.min(pageSize as number, 200) : 50;
  const pages = Math.max(1, Math.ceil(items.length / size));
  const index = Number.isInteger(pageIdx) && (pageIdx as number) >= 0 ? Math.min(pageIdx as number, pages - 1) : 0;
  return { items: items.slice(index * size, index * size + size), total: items.length, pageIdx: index, pages };
}

const typeFilter = (value: unknown): Set<string> | null => Array.isArray(value) && value.length
  ? new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase())) : null;

export class DevtoolsLog {
  private console: ConsoleEntry[] = [];
  private network: NetworkEntry[] = [];
  private readonly requests = new Map<string, NetworkEntry>();
  private nextMsg = 1;
  private nextReq = 1;

  constructor(private mainFrameId: string, private readonly max = DEVTOOLS_MAX_ENTRIES) {}

  /** Keeps only what belongs to the current document, like DevTools without "preserve log". */
  private newDocument(): void {
    this.console = []; this.network = []; this.requests.clear();
  }

  private push<T>(list: T[], entry: T): T[] {
    list.push(entry);
    return list.length > this.max ? list.splice(0, list.length - this.max) : [];
  }

  handle(method: string, params: Params): void {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const frame = params.stackTrace?.callFrames?.[0];
        const args = (Array.isArray(params.args) ? params.args : []).slice(0, 20).map(remoteObjectText);
        this.push(this.console, { msgid: this.nextMsg++, type: String(params.type ?? 'log'), text: clip(args.join(' '), TEXT_LIMIT),
          timestamp: Number(params.timestamp) || Date.now(), url: frame?.url ? clip(frame.url, URL_LIMIT) : undefined,
          line: frame ? (frame.lineNumber ?? 0) + 1 : undefined, args, stack: stackOf(params.stackTrace) });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails ?? {};
        this.push(this.console, { msgid: this.nextMsg++, type: 'error',
          text: clip(details.exception?.description ?? details.text ?? 'Uncaught exception', TEXT_LIMIT),
          timestamp: Number(params.timestamp) || Date.now(), url: details.url ? clip(details.url, URL_LIMIT) : undefined,
          line: details.lineNumber !== undefined ? details.lineNumber + 1 : undefined, args: [], stack: stackOf(details.stackTrace) });
        break;
      }
      case 'Log.entryAdded': {
        const entry = params.entry ?? {};
        // Runtime already reports console calls; Log adds what the browser itself says (CSP, network, interventions).
        if (entry.source === 'console-api') return;
        this.push(this.console, { msgid: this.nextMsg++, type: String(entry.level ?? 'info'), text: clip(entry.text, TEXT_LIMIT),
          timestamp: Number(entry.timestamp) || Date.now(), url: entry.url ? clip(entry.url, URL_LIMIT) : undefined,
          line: entry.lineNumber !== undefined ? entry.lineNumber + 1 : undefined, args: [], stack: stackOf(entry.stackTrace) });
        break;
      }
      case 'Page.frameNavigated':
        if (!params.frame?.parentId && params.frame?.id) this.mainFrameId = params.frame.id;
        break;
      case 'Network.requestWillBeSent': {
        if (params.type === 'Document' && params.frameId === this.mainFrameId && params.requestId === params.loaderId
          && !params.redirectResponse) this.newDocument();
        const previous = this.requests.get(params.requestId);
        // A redirect reuses the request id: close the hop that was redirected, then follow the new one.
        if (previous && params.redirectResponse) {
          this.respond(previous, params.redirectResponse); previous.state = 'finished';
        }
        const entry: NetworkEntry = { reqid: this.nextReq++, requestId: String(params.requestId),
          method: String(params.request?.method ?? 'GET'), url: clip(params.request?.url, URL_LIMIT),
          resourceType: String(params.type ?? 'Other'), timestamp: Number(params.wallTime) * 1000 || Date.now(),
          requestHeaders: redactHeaders(params.request?.headers),
          postData: params.request?.postData !== undefined ? clip(params.request.postData, BODY_LIMIT) : undefined, state: 'pending' };
        this.requests.set(entry.requestId, entry);
        // A redirect hop shares its id with the request that replaced it: only forget the live one.
        for (const evicted of this.push(this.network, entry)) {
          if (this.requests.get(evicted.requestId) === evicted) this.requests.delete(evicted.requestId);
        }
        break;
      }
      case 'Network.responseReceived': {
        const entry = this.requests.get(params.requestId);
        if (entry) this.respond(entry, params.response ?? {});
        break;
      }
      case 'Network.loadingFinished': {
        const entry = this.requests.get(params.requestId);
        if (entry) { entry.state = 'finished'; entry.encodedDataLength = params.encodedDataLength; }
        break;
      }
      case 'Network.loadingFailed': {
        const entry = this.requests.get(params.requestId);
        if (entry) { entry.state = 'failed'; entry.errorText = clip(params.blockedReason ?? params.errorText, TEXT_LIMIT); }
        break;
      }
    }
  }

  private respond(entry: NetworkEntry, response: Params): void {
    entry.status = response.status; entry.statusText = clip(response.statusText, 200);
    entry.mimeType = clip(response.mimeType, 200); entry.responseHeaders = redactHeaders(response.headers);
    entry.remoteAddress = response.remoteIPAddress ? `${response.remoteIPAddress}:${response.remotePort}` : undefined;
    entry.fromCache = !!(response.fromDiskCache || response.fromServiceWorker || response.fromPrefetchCache);
  }

  listConsole(query: Params) {
    const types = typeFilter(query.types);
    const listed = page(this.console.filter((m) => !types || types.has(m.type.toLowerCase())), query.pageSize, query.pageIdx);
    return { ...listed, items: undefined, messages: listed.items.map(({ msgid, type, text, url, line }) =>
      ({ msgid, type, text: clip(text, 500), source: url ? `${url}${line ? `:${line}` : ''}` : undefined })) };
  }

  getConsole(msgid: unknown): ConsoleEntry | undefined {
    return this.console.find((m) => m.msgid === msgid);
  }

  listNetwork(query: Params) {
    const types = typeFilter(query.resourceTypes);
    const listed = page(this.network.filter((r) => !types || types.has(r.resourceType.toLowerCase())), query.pageSize, query.pageIdx);
    return { ...listed, items: undefined, requests: listed.items.map(({ reqid, method, url, resourceType, status, state, errorText }) =>
      ({ reqid, method, url, resourceType, status, state, ...(errorText ? { errorText } : {}) })) };
  }

  getNetwork(reqid: unknown): NetworkEntry | undefined {
    return this.network.find((r) => r.reqid === reqid);
  }
}

/** Presets match chrome-devtools-mcp, so an agent's habits carry over (throughput in bytes/s, latency in ms). */
export const NETWORK_CONDITIONS: Record<string, { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }> = {
  'No emulation': { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  Offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'Slow 3G': { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  'Fast 3G': { offline: false, latency: 562.5, downloadThroughput: 180_000, uploadThroughput: 84_375 },
  'Slow 4G': { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 93_750 },
  'Fast 4G': { offline: false, latency: 60, downloadThroughput: 1_012_500, uploadThroughput: 168_750 },
};

/** Collected in the page, at stop: navigation timing and the Core Web Vitals the buffered observers kept. */
export const PERFORMANCE_SCRIPT = `(async () => {
  const take = (type) => new Promise((resolve) => {
    try {
      const seen = [];
      const observer = new PerformanceObserver((list) => seen.push(...list.getEntries()));
      observer.observe({ type, buffered: true });
      setTimeout(() => { observer.disconnect(); resolve(seen); }, 50);
    } catch { resolve([]); }
  });
  const round = (n) => typeof n === 'number' ? Math.round(n * 10) / 10 : null;
  const nav = performance.getEntriesByType('navigation')[0];
  const lcp = (await take('largest-contentful-paint')).at(-1);
  const cls = (await take('layout-shift')).filter((e) => !e.hadRecentInput).reduce((sum, e) => sum + e.value, 0);
  const longTasks = await take('longtask');
  const events = await take('event');
  const paint = Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, round(e.startTime)]));
  return {
    url: location.href,
    navigation: nav ? { type: nav.type, ttfb: round(nav.responseStart), domContentLoaded: round(nav.domContentLoadedEventEnd),
      load: round(nav.loadEventEnd), transferSize: nav.transferSize } : null,
    firstContentfulPaint: paint['first-contentful-paint'] ?? null,
    largestContentfulPaint: lcp ? { time: round(lcp.startTime), element: lcp.element ? lcp.element.tagName.toLowerCase() + (lcp.element.id ? '#' + lcp.element.id : '') : null, url: lcp.url || null } : null,
    cumulativeLayoutShift: Math.round(cls * 1000) / 1000,
    interactionToNextPaint: events.length ? round(Math.max(...events.filter((e) => e.interactionId).map((e) => e.duration), 0)) : null,
    longTasks: { count: longTasks.length, totalBlockingTime: round(longTasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0)) },
    resources: performance.getEntriesByType('resource').length,
  };
})()`;

/** Turns CDP `Performance.getMetrics` into the few numbers worth reading, as a delta over the trace. */
export function metricsDelta(before: Array<{ name: string; value: number }>, after: Array<{ name: string; value: number }>) {
  const read = (list: Array<{ name: string; value: number }>) => Object.fromEntries(list.map((m) => [m.name, m.value]));
  const a = read(before); const b = read(after);
  const diff = (name: string, scale = 1) => b[name] !== undefined ? Math.round(((b[name] ?? 0) - (a[name] ?? 0)) * scale * 10) / 10 : null;
  return {
    scriptDurationMs: diff('ScriptDuration', 1000), taskDurationMs: diff('TaskDuration', 1000),
    layoutDurationMs: diff('LayoutDuration', 1000), recalcStyleDurationMs: diff('RecalcStyleDuration', 1000),
    layoutCount: diff('LayoutCount'), jsHeapUsedMB: b.JSHeapUsedSize !== undefined ? Math.round(b.JSHeapUsedSize / 1e5) / 10 : null,
    nodes: b.Nodes ?? null, documents: b.Documents ?? null,
  };
}
