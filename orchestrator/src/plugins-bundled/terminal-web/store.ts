/**
 * Where the web terminal's sessions live, as the routes see it. Two places
 * behind one interface:
 *
 * - the terminal host (`src/terminal-host/`), a process of its own that keeps
 *   the shells across a daemon restart — the normal case;
 * - this process, as before, when the host cannot start: the shells then die
 *   with the daemon, and `persistence()` says so.
 *
 * Asynchronous because the host answers over a socket. Access control is NOT
 * here: the routes decide who may act, the store only refuses an owner
 * mismatch.
 */
import type { PtySpawnOptions, TerminalClient, TerminalSessionInfo, TerminalSessions } from '../../terminal-host/sessions.js';

export type AttachHandle = {
  input(data: string): void;
  resize(cols: unknown, rows: unknown): void;
  detach(): void;
};

export type CreateInput = Omit<PtySpawnOptions, 'cols' | 'rows'> & { cols?: unknown; rows?: unknown; scope?: string | null };

/**
 * `host`: shells survive a daemon restart. `in-process`: they do not, and
 * `reason` says why (`host_unavailable`, `host_untrusted`, `host_incompatible`,
 * `host_spawn_failed`, `no_detached_launch`). `not-started`: no host runs
 * yet, the next shell starts one.
 */
export type Persistence = { mode: 'host' | 'in-process' | 'not-started'; reason?: string; via?: string };

export interface SessionStore {
  list(ownerId: string): Promise<TerminalSessionInfo[]>;
  get(ownerId: string, id: string): Promise<TerminalSessionInfo | null>;
  create(ownerId: string, input: CreateInput): Promise<TerminalSessionInfo>;
  kill(ownerId: string, id: string): Promise<boolean>;
  attach(ownerId: string, id: string, client: TerminalClient): Promise<AttachHandle | null>;
  /** Where the shells run. Never starts the host. */
  persistence(): Promise<Persistence>;
  /** Kills every shell, wherever it runs — the module was disabled. */
  dispose(): Promise<void>;
  /** Lets go without killing: what a daemon restart amounts to. */
  disconnect(): void;
}

/** The sessions of this process, behind the store interface. */
export function localStore(sessions: TerminalSessions, reason = 'no_detached_launch'): SessionStore {
  return {
    list: async (ownerId) => sessions.list(ownerId),
    get: async (ownerId, id) => sessions.get(ownerId, id),
    create: async (ownerId, input) => sessions.create(ownerId, input),
    kill: async (ownerId, id) => sessions.kill(ownerId, id),
    attach: async (ownerId, id, client) => sessions.attach(ownerId, id, client),
    persistence: async () => ({ mode: 'in-process', reason }),
    dispose: async () => sessions.disposeAll(),
    disconnect: () => sessions.disposeAll(),
  };
}
