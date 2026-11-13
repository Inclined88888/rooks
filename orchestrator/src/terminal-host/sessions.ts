/**
 * Web terminal sessions — one pseudo-terminal per session, owned by one user.
 *
 * A session outlives its clients: a phone that locks its screen drops the
 * WebSocket, but `sudo apt upgrade` must keep running on the host. The PTY
 * stays alive with a bounded scrollback, and the next client that attaches
 * gets that scrollback replayed before the live stream. A session nobody is
 * attached to is killed after the idle delay; one whose shell exited is
 * dropped as soon as its last client has seen the exit.
 *
 * The spawner is injected so tests drive a fake PTY: the real one is
 * node-pty, loaded lazily so a host where the native module is missing only
 * loses this feature, not the daemon.
 */
import { randomUUID } from 'node:crypto';

/** The slice of a node-pty `IPty` this module relies on. */
export type Pty = {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type PtySpawnOptions = {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
};

export type PtySpawner = (opts: PtySpawnOptions) => Pty;

/** A connected viewer: a WebSocket in production, a recorder in tests. */
export type TerminalClient = {
  send(message: ServerMessage): void;
  close(): void;
};

export type ServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number | null };

export type TerminalSessionInfo = {
  id: string;
  /** What the shell belongs to — `project:<slug>`, `agent:<name>`, or null
   *  (no context). The UI only shows the shells of the current one. */
  scope: string | null;
  cwd: string;
  shell: string;
  createdAt: number;
  lastActivityAt: number;
  clients: number;
  cols: number;
  rows: number;
  exited: boolean;
  exitCode: number | null;
};

export type SessionsOptions = {
  spawn: PtySpawner;
  /** Resolved at each use, so a settings change applies without restart. */
  idleMs: () => number;
  /** Scrollback kept for a reattach, in characters. */
  scrollbackChars?: number;
  maxPerOwner?: number;
  now?: () => number;
};

export class TerminalLimitError extends Error {}

type Session = {
  info: TerminalSessionInfo;
  ownerId: string;
  pty: Pty;
  chunks: string[];
  size: number;
  clients: Set<TerminalClient>;
  idleTimer: NodeJS.Timeout | null;
};

export const MIN_COLS = 2;
export const MAX_COLS = 500;
export const MIN_ROWS = 1;
export const MAX_ROWS = 300;

export function clampSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const c = typeof cols === 'number' && Number.isFinite(cols) ? Math.round(cols) : 80;
  const r = typeof rows === 'number' && Number.isFinite(rows) ? Math.round(rows) : 24;
  return {
    cols: Math.min(MAX_COLS, Math.max(MIN_COLS, c)),
    rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, r)),
  };
}

export class TerminalSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly scrollbackChars: number;
  private readonly maxPerOwner: number;
  private readonly now: () => number;

  constructor(private readonly opts: SessionsOptions) {
    this.scrollbackChars = opts.scrollbackChars ?? 200_000;
    this.maxPerOwner = opts.maxPerOwner ?? 8;
    this.now = opts.now ?? Date.now;
  }

  create(ownerId: string, input: Omit<PtySpawnOptions, 'cols' | 'rows'> & { cols?: unknown; rows?: unknown; scope?: string | null }): TerminalSessionInfo {
    if (this.list(ownerId).length >= this.maxPerOwner) {
      throw new TerminalLimitError(`at most ${this.maxPerOwner} terminal sessions per user`);
    }
    const { cols, rows } = clampSize(input.cols, input.rows);
    const pty = this.opts.spawn({ shell: input.shell, args: input.args, cwd: input.cwd, env: input.env, cols, rows });
    const at = this.now();
    const session: Session = {
      info: {
        id: randomUUID(),
        scope: input.scope ?? null,
        cwd: input.cwd,
        shell: input.shell,
        createdAt: at,
        lastActivityAt: at,
        clients: 0,
        cols,
        rows,
        exited: false,
        exitCode: null,
      },
      ownerId,
      pty,
      chunks: [],
      size: 0,
      clients: new Set(),
      idleTimer: null,
    };
    this.sessions.set(session.info.id, session);
    pty.onData((data) => this.onOutput(session, data));
    pty.onExit(({ exitCode }) => this.onExit(session, exitCode));
    // Nobody is attached yet: a session created and never opened must not leak.
    this.armIdle(session);
    return { ...session.info };
  }

  /** Sessions of one owner, oldest first. */
  list(ownerId: string): TerminalSessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => s.ownerId === ownerId)
      .sort((a, b) => a.info.createdAt - b.info.createdAt)
      .map((s) => ({ ...s.info }));
  }

  /** The session if it exists AND belongs to `ownerId` — never someone else's. */
  get(ownerId: string, id: string): TerminalSessionInfo | null {
    const s = this.sessions.get(id);
    return s && s.ownerId === ownerId ? { ...s.info } : null;
  }

  kill(ownerId: string, id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.ownerId !== ownerId) return false;
    this.destroy(s);
    return true;
  }

  /**
   * Attaches a client: replays the scrollback, then streams. Returns null when
   * the session does not exist or is not the caller's.
   */
  attach(ownerId: string, id: string, client: TerminalClient): {
    input(data: string): void;
    resize(cols: unknown, rows: unknown): void;
    detach(): void;
  } | null {
    const s = this.sessions.get(id);
    if (!s || s.ownerId !== ownerId) return null;
    this.disarmIdle(s);
    s.clients.add(client);
    s.info.clients = s.clients.size;
    if (s.size > 0) client.send({ type: 'output', data: s.chunks.join('') });
    if (s.info.exited) client.send({ type: 'exit', code: s.info.exitCode });
    let attached = true;
    return {
      input: (data) => {
        if (!attached || s.info.exited) return;
        s.info.lastActivityAt = this.now();
        s.pty.write(data);
      },
      resize: (cols, rows) => {
        if (!attached || s.info.exited) return;
        const size = clampSize(cols, rows);
        if (size.cols === s.info.cols && size.rows === s.info.rows) return;
        s.info.cols = size.cols;
        s.info.rows = size.rows;
        try { s.pty.resize(size.cols, size.rows); } catch { /* the shell is exiting */ }
      },
      detach: () => {
        if (!attached) return;
        attached = false;
        s.clients.delete(client);
        s.info.clients = s.clients.size;
        if (s.clients.size > 0) return;
        if (s.info.exited) this.forget(s);
        else this.armIdle(s);
      },
    };
  }

  /** Sessions of every owner — the terminal host leaves once it reaches 0. */
  count(): number {
    return this.sessions.size;
  }

  /** Kills every session — module unload, daemon shutdown. */
  disposeAll(): void {
    for (const s of [...this.sessions.values()]) this.destroy(s);
  }

  private onOutput(session: Session, data: string): void {
    session.info.lastActivityAt = this.now();
    session.chunks.push(data);
    session.size += data.length;
    while (session.size > this.scrollbackChars && session.chunks.length > 1) {
      session.size -= session.chunks.shift()!.length;
    }
    if (session.size > this.scrollbackChars) {
      const only = session.chunks[0]!.slice(-this.scrollbackChars);
      session.chunks = [only];
      session.size = only.length;
    }
    for (const client of session.clients) client.send({ type: 'output', data });
  }

  private onExit(session: Session, exitCode: number): void {
    if (session.info.exited) return;
    session.info.exited = true;
    session.info.exitCode = Number.isFinite(exitCode) ? exitCode : null;
    for (const client of session.clients) client.send({ type: 'exit', code: session.info.exitCode });
    if (session.clients.size === 0) this.forget(session);
  }

  private armIdle(session: Session): void {
    this.disarmIdle(session);
    const ms = Math.max(1_000, this.opts.idleMs());
    session.idleTimer = setTimeout(() => this.destroy(session), ms);
    session.idleTimer.unref?.();
  }

  private disarmIdle(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  private destroy(session: Session): void {
    this.forget(session);
    if (!session.info.exited) {
      try { session.pty.kill(); } catch { /* already gone */ }
    }
    for (const client of session.clients) {
      try { client.close(); } catch { /* socket already closed */ }
    }
    session.clients.clear();
  }

  private forget(session: Session): void {
    this.disarmIdle(session);
    this.sessions.delete(session.info.id);
  }
}
