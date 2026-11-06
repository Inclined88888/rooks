/**
 * An event stream (`text/event-stream`) read from another machine of the
 * fleet, with the same rules as `machineRequest`: the URL policy, the address
 * vetted again at connect time, the system CAs, no redirect, the token in
 * `Authorization` only. What changes is the length of the call: it stays open,
 * so it is capped per event instead of in total, and cut when the machine goes
 * silent longer than its keep-alive allows.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { classifyMachineError, machineConnectOptions, MachineRequestError, type MachineResolver } from './client.js';

/** A Timon daemon pings every 15 s (`TIMON_SSE_PING_MS`): four missed pings is a dead link. */
export const MACHINE_STREAM_IDLE_MS = 60_000;
/** One event larger than this is not a notification signal: the stream is cut. */
export const MACHINE_STREAM_MAX_EVENT_BYTES = 256 * 1024;

export type MachineStreamEnd =
  /** The machine answered, but not with a stream: 401 (device dead), 403, 404… */
  | { kind: 'refused'; status: number }
  /** Transport failure, idle link, oversized event. */
  | { kind: 'error'; error: MachineRequestError }
  /** The machine closed the stream. */
  | { kind: 'ended' }
  /** `close()` was called. */
  | { kind: 'closed' };

export type MachineStreamHandlers = {
  /** The stream is open: the machine answered 200. */
  onOpen?: () => void;
  onEvent: (name: string, data: string) => void;
  /** Called exactly once. */
  onEnd: (end: MachineStreamEnd) => void;
};

export type MachineStreamCall = {
  path: string;
  token: string;
  idleMs?: number;
  /** Test seam, as in `machineRequest`. */
  resolver?: MachineResolver;
};

/**
 * Minimal `text/event-stream` parser: `event:` and `data:` fields, a blank line
 * dispatches, `:` comments (the pings) only prove the link is alive.
 */
export class EventStreamParser {
  private buffer = '';
  private name = '';
  private data: string[] = [];

  constructor(private readonly dispatch: (name: string, data: string) => void, private readonly maxEventBytes: number) {}

  /** Returns false once an event outgrew the cap: the caller cuts the stream. */
  push(chunk: string): boolean {
    this.buffer += chunk;
    let newline = this.buffer.search(/\r\n|\r|\n/);
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      const width = this.buffer.startsWith('\r\n', newline) ? 2 : 1;
      this.buffer = this.buffer.slice(newline + width);
      this.line(line);
      newline = this.buffer.search(/\r\n|\r|\n/);
    }
    // What is still pending is one event being built: that is what the cap bounds.
    const pending = this.buffer.length + this.data.reduce((total, part) => total + part.length, 0);
    return pending <= this.maxEventBytes;
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) this.dispatch(this.name || 'message', this.data.join('\n'));
      this.name = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') this.name = value;
    else if (field === 'data') this.data.push(value);
  }
}

/** Opens `<base><path>` as an event stream. The handle closes it. */
export function openMachineStream(base: string, call: MachineStreamCall, handlers: MachineStreamHandlers): { close: () => void } {
  let ended = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const idleMs = call.idleMs ?? MACHINE_STREAM_IDLE_MS;
  let outgoing: ReturnType<typeof httpRequest> | null = null;

  const finish = (end: MachineStreamEnd): void => {
    if (ended) return;
    ended = true;
    if (idleTimer) clearTimeout(idleTimer);
    outgoing?.destroy();
    handlers.onEnd(end);
  };
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish({ kind: 'error', error: new MachineRequestError('timeout', 'the machine stream went silent') }), idleMs);
    idleTimer.unref?.();
  };

  let prepared: ReturnType<typeof machineConnectOptions>;
  try {
    prepared = machineConnectOptions(base, {
      method: 'GET',
      path: call.path,
      token: call.token,
      headers: { accept: 'text/event-stream', 'cache-control': 'no-cache' },
      resolver: call.resolver,
    });
  } catch (err) {
    // Reported asynchronously, like every other end: the caller's handle exists first.
    queueMicrotask(() => finish({
      kind: 'error',
      error: err instanceof MachineRequestError ? err : new MachineRequestError('invalid_url', 'invalid machine URL'),
    }));
    return { close: () => finish({ kind: 'closed' }) };
  }

  armIdle();
  outgoing = (prepared.secure ? httpsRequest : httpRequest)(prepared.options, (res) => {
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      res.resume();
      finish({ kind: 'error', error: new MachineRequestError('redirect', 'the machine answered with a redirect') });
      return;
    }
    if (status !== 200 || !/\btext\/event-stream\b/i.test(String(res.headers['content-type'] ?? ''))) {
      res.resume();
      finish({ kind: 'refused', status });
      return;
    }
    handlers.onOpen?.();
    const parser = new EventStreamParser((name, data) => {
      if (!ended) handlers.onEvent(name, data);
    }, MACHINE_STREAM_MAX_EVENT_BYTES);
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      armIdle();
      if (!parser.push(chunk)) finish({ kind: 'error', error: new MachineRequestError('too_large', 'the machine sent an oversized event') });
    });
    res.on('end', () => finish({ kind: 'ended' }));
    res.on('error', (err: NodeJS.ErrnoException) => finish({ kind: 'error', error: classifyMachineError(err) }));
    res.on('close', () => finish({ kind: 'ended' }));
  });
  outgoing.on('error', (err: NodeJS.ErrnoException) => finish({ kind: 'error', error: classifyMachineError(err) }));
  outgoing.end();
  return { close: () => finish({ kind: 'closed' }) };
}
