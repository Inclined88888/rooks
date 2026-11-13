/**
 * Terminal host — the daemon side of one authenticated connection
 * (`protocol.ts`). The daemon keeps one for requests and opens one more per
 * attached viewer: when the daemon goes away, every attachment drops with
 * it, and the host's idle reap takes over exactly as it did for a vanished
 * browser.
 */
import { connect, type Socket } from 'node:net';
import { negotiate, newNonce, proofMatches, proofOf, readFrames, sendFrame, type HostErrorCode, type Welcome } from './protocol.js';

/**
 * Why a connection did not open:
 * - `absent`: nothing listens — the host must be launched;
 * - `untrusted`: something answered but failed the handshake — never launch
 *   over it, never send it a keystroke;
 * - `protocol`: a host that refuses our version outright (cannot happen with
 *   the frozen base, kept for a broken peer);
 * - `timeout`: no complete handshake in time.
 */
export type ConnectFailure = 'absent' | 'untrusted' | 'protocol' | 'timeout';

export class HostConnectError extends Error {
  constructor(readonly code: ConnectFailure, message: string) { super(message); }
}

export class HostRequestError extends Error {
  constructor(readonly code: HostErrorCode | 'closed' | 'timeout', message: string) { super(message); }
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };

export class HostLink {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  /** Frames that are not answers: the output of an attached session. */
  onFrame: (frame: Record<string, unknown>) => void = () => {};
  onClose: () => void = () => {};

  private constructor(private readonly socket: Socket, readonly welcome: Welcome) {}

  get protocol(): number { return this.welcome.protocol; }
  get alive(): boolean { return !this.closed; }

  static open(endpoint: string, token: string, timeoutMs = 3_000): Promise<HostLink> {
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint);
      const nonce = newNonce();
      let link: HostLink | null = null;
      let settled = false;
      const settle = (err: HostConnectError | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { socket.destroy(); reject(err); } else resolve(link!);
      };
      const timer = setTimeout(() => settle(new HostConnectError('timeout', 'terminal host handshake timed out')), timeoutMs);
      socket.on('error', (err: NodeJS.ErrnoException) => {
        const absent = err.code === 'ENOENT' || err.code === 'ECONNREFUSED';
        settle(new HostConnectError(absent ? 'absent' : 'untrusted', `terminal host unreachable (${err.code ?? 'error'})`));
        link?.dropped();
      });
      socket.on('close', () => {
        settle(new HostConnectError('untrusted', 'terminal host closed the connection during the handshake'));
        link?.dropped();
      });
      readFrames(socket, (frame) => {
        if (link) { link.dispatch(frame); return; }
        if (frame.t === 'hello') {
          const protocol = typeof frame.protocol === 'number' && typeof frame.min === 'number'
            ? negotiate({ protocol: frame.protocol, min: frame.min })
            : 0;
          if (typeof frame.nonce !== 'string') { settle(new HostConnectError('untrusted', 'malformed hello')); return; }
          sendFrame(socket, { t: 'auth', protocol, nonce, proof: proofOf(token, 'daemon', frame.nonce) });
          return;
        }
        if (frame.t === 'welcome') {
          if (!proofMatches(token, 'host', nonce, frame.proof)) {
            settle(new HostConnectError('untrusted', 'the terminal host could not prove the token'));
            return;
          }
          link = new HostLink(socket, {
            t: 'welcome',
            protocol: Number(frame.protocol) || 0,
            proof: String(frame.proof),
            build: typeof frame.build === 'string' ? frame.build : '',
            entry: typeof frame.entry === 'string' ? frame.entry : '',
            pid: typeof frame.pid === 'number' ? frame.pid : 0,
            sessions: typeof frame.sessions === 'number' ? frame.sessions : 0,
          });
          settle(null);
          return;
        }
        if (frame.t === 'denied') {
          settle(new HostConnectError(frame.reason === 'protocol' ? 'protocol' : 'untrusted', `terminal host refused: ${String(frame.reason)}`));
          return;
        }
        settle(new HostConnectError('untrusted', 'unexpected frame during the handshake'));
      });
    });
  }

  request<T>(op: string, params: Record<string, unknown> = {}, timeoutMs = 5_000): Promise<T> {
    if (this.closed) return Promise.reject(new HostRequestError('closed', 'terminal host connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostRequestError('timeout', `terminal host did not answer ${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      sendFrame(this.socket, { t: 'req', id, op, ...params });
    });
  }

  send(frame: object): void {
    if (!this.closed) sendFrame(this.socket, frame);
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
    this.dropped();
  }

  private dispatch(frame: Record<string, unknown>): void {
    if (frame.t !== 'res') { this.onFrame(frame); return; }
    const id = typeof frame.id === 'number' ? frame.id : -1;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (frame.ok === true) p.resolve(frame.result);
    else p.reject(new HostRequestError((frame.error as HostErrorCode) ?? 'bad_request', String(frame.message ?? 'terminal host error')));
  }

  private dropped(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new HostRequestError('closed', 'terminal host connection closed'));
    }
    this.pending.clear();
    this.onClose();
  }
}
