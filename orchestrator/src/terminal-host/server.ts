/**
 * Terminal host — the server side: owns the `TerminalSessions` and serves the
 * daemon over the local channel described in `protocol.ts`.
 *
 * It has no idea who the users are: the daemon decided the access before
 * asking, and passes the owner with every request. The owner check of
 * `TerminalSessions` still applies, so one user's request never reaches
 * another's shell even through a confused caller.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { z } from 'zod';
import {
  chunksOf, MIN_PROTOCOL_VERSION, newNonce, proofMatches, proofOf, PROTOCOL_VERSION, readFrames, sendFrame,
  type HostErrorCode,
} from './protocol.js';
import { TerminalLimitError, TerminalSessions, type PtySpawner, type TerminalClient } from './sessions.js';

export type HostServerOptions = {
  token: string;
  spawn: PtySpawner;
  /** Release of the code running here, reported to the daemon. */
  build: string;
  /** Path of the entry point running here, reported to the daemon. */
  entry: string;
  /** Leaves after this long without any session (a grace from the start). */
  exitAfterMs: number;
  onIdleExit: () => void;
  /** Detached sessions are reaped after this; the daemon updates it. */
  idleMs?: number;
  authTimeoutMs?: number;
  log?: (line: string) => void;
  now?: () => number;
};

const Owner = z.string().min(1).max(256);
const SessionId = z.string().min(1).max(64);
const Text = z.string().max(65_536);

const Request = z.discriminatedUnion('op', [
  z.object({ t: z.literal('req'), id: z.number().int(), op: z.literal('stats') }),
  z.object({ t: z.literal('req'), id: z.number().int(), op: z.literal('shutdown'), ifIdle: z.boolean() }),
  z.object({ t: z.literal('req'), id: z.number().int(), op: z.literal('config'), idleMs: z.number().int().min(1_000) }),
  z.object({ t: z.literal('req'), id: z.number().int(), op: z.literal('list'), ownerId: Owner }),
  z.object({ t: z.literal('req'), id: z.number().int(), op: z.literal('get'), ownerId: Owner, sessionId: SessionId }),
  z.object({ t: z.literal('req'), id: z.number().int(), op: z.literal('kill'), ownerId: Owner, sessionId: SessionId }),
  z.object({ t: z.literal('req'), id: z.number().int(), op: z.literal('killAll') }),
  z.object({ t: z.literal('req'), id: z.number().int(), op: z.literal('attach'), ownerId: Owner, sessionId: SessionId }),
  z.object({
    t: z.literal('req'), id: z.number().int(), op: z.literal('create'), ownerId: Owner,
    shell: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64),
    cwd: z.string().min(1).max(4096),
    env: z.record(z.string(), z.string()),
    cols: z.number().optional(),
    rows: z.number().optional(),
    scope: z.string().max(256).nullable().optional(),
    idleMs: z.number().int().min(1_000).optional(),
  }),
]);

/** Requests every protocol version answers — the frozen base of `protocol.ts`. */
const BASE_OPS = new Set(['stats', 'shutdown']);

const Auth = z.object({ t: z.literal('auth'), protocol: z.number().int(), nonce: z.string().min(16).max(128), proof: z.string().max(128) });
const Stream = z.discriminatedUnion('t', [
  z.object({ t: z.literal('in'), data: Text }),
  z.object({ t: z.literal('resize'), cols: z.number(), rows: z.number() }),
]);

export type HostServer = {
  server: Server;
  sessions: TerminalSessions;
  /** Kills every shell and closes every connection. */
  close(): void;
};

export function createHostServer(opts: HostServerOptions): HostServer {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  let idleMs = opts.idleMs ?? 30 * 60_000;
  const sessions = new TerminalSessions({ spawn: opts.spawn, idleMs: () => idleMs });
  const sockets = new Set<Socket>();
  let busyAt = now();
  let closed = false;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    serve(socket);
  });

  // Polling rather than a callback in `TerminalSessions`: a session leaves on
  // exit, kill, idle reap — one check covers them all.
  const tick = setInterval(() => {
    if (sessions.count() > 0) { busyAt = now(); return; }
    if (now() - busyAt >= opts.exitAfterMs) {
      log('no session left, leaving');
      opts.onIdleExit();
    }
  }, Math.max(50, Math.min(30_000, Math.floor(opts.exitAfterMs / 4))));

  function close(): void {
    if (closed) return;
    closed = true;
    clearInterval(tick);
    sessions.disposeAll();
    for (const s of sockets) s.destroy();
    server.close();
  }

  function serve(socket: Socket): void {
    const nonce = newNonce();
    let protocol = -1;
    let attached: ReturnType<TerminalSessions['attach']> = null;
    const authTimer = setTimeout(() => socket.destroy(), opts.authTimeoutMs ?? 5_000);
    authTimer.unref?.();
    socket.on('close', () => {
      clearTimeout(authTimer);
      attached?.detach();
      attached = null;
    });
    sendFrame(socket, { t: 'hello', protocol: PROTOCOL_VERSION, min: MIN_PROTOCOL_VERSION, nonce });

    const reply = (id: number, result: unknown): void => sendFrame(socket, { t: 'res', id, ok: true, result });
    const fail = (id: number, error: HostErrorCode, message: string): void => sendFrame(socket, { t: 'res', id, ok: false, error, message });

    readFrames(socket, (frame) => {
      if (protocol < 0) {
        const auth = Auth.safeParse(frame);
        const supported = auth.success && (auth.data.protocol === 0 || (auth.data.protocol >= MIN_PROTOCOL_VERSION && auth.data.protocol <= PROTOCOL_VERSION));
        if (!auth.success || !proofMatches(opts.token, 'daemon', nonce, auth.data.proof)) {
          // Same answer for every refusal: nothing to learn by probing.
          sendFrame(socket, { t: 'denied', reason: 'unauthorized' });
          socket.end();
          return;
        }
        if (!supported) {
          sendFrame(socket, { t: 'denied', reason: 'protocol' });
          socket.end();
          return;
        }
        clearTimeout(authTimer);
        protocol = auth.data.protocol;
        sendFrame(socket, {
          t: 'welcome', protocol, proof: proofOf(opts.token, 'host', auth.data.nonce),
          build: opts.build, entry: opts.entry, pid: process.pid, sessions: sessions.count(),
        });
        return;
      }

      if (attached) {
        const msg = Stream.safeParse(frame);
        if (!msg.success) return;
        if (msg.data.t === 'in') attached.input(msg.data.data);
        else attached.resize(msg.data.cols, msg.data.rows);
        return;
      }

      const req = Request.safeParse(frame);
      if (!req.success) {
        const id = typeof frame.id === 'number' ? frame.id : -1;
        fail(id, 'bad_request', 'malformed request');
        return;
      }
      const r = req.data;
      if (protocol === 0 && !BASE_OPS.has(r.op)) { fail(r.id, 'unsupported', `${r.op} needs a common protocol version`); return; }
      switch (r.op) {
        case 'stats':
          reply(r.id, { sessions: sessions.count(), build: opts.build, entry: opts.entry, pid: process.pid });
          return;
        case 'shutdown':
          if (r.ifIdle && sessions.count() > 0) { fail(r.id, 'busy', 'sessions are running'); return; }
          reply(r.id, { stopping: true });
          log('shutdown requested by the daemon');
          // After the reply has left: the daemon waits for it before relaunching.
          socket.end(() => opts.onIdleExit());
          return;
        case 'config':
          idleMs = r.idleMs;
          reply(r.id, { idleMs });
          return;
        case 'list':
          reply(r.id, sessions.list(r.ownerId));
          return;
        case 'get':
          reply(r.id, sessions.get(r.ownerId, r.sessionId));
          return;
        case 'kill':
          reply(r.id, sessions.kill(r.ownerId, r.sessionId));
          return;
        case 'killAll':
          sessions.disposeAll();
          reply(r.id, true);
          return;
        case 'create': {
          if (r.idleMs) idleMs = r.idleMs;
          try {
            const info = sessions.create(r.ownerId, {
              shell: r.shell, args: r.args, cwd: r.cwd, env: r.env, cols: r.cols, rows: r.rows, scope: r.scope ?? null,
            });
            busyAt = now();
            reply(r.id, info);
          } catch (err) {
            if (err instanceof TerminalLimitError) fail(r.id, 'limit', err.message);
            else fail(r.id, 'spawn', (err as Error).message);
          }
          return;
        }
        case 'attach': {
          if (!sessions.get(r.ownerId, r.sessionId)) { reply(r.id, false); return; }
          // The answer goes first: the scrollback `attach` replays at once must follow it.
          reply(r.id, true);
          const client: TerminalClient = {
            send: (m) => {
              if (m.type === 'output') for (const data of chunksOf(m.data)) sendFrame(socket, { t: 'out', data });
              else sendFrame(socket, { t: 'exit', code: m.code });
            },
            close: () => socket.end(),
          };
          attached = sessions.attach(r.ownerId, r.sessionId, client);
          return;
        }
      }
    });
  }

  return { server, sessions, close };
}
