import { apiErrorMessage } from '@/lib/api-error';
/**
 * Client side of the built-in terminal: the daemon's REST routes (through the
 * Next proxy), the stream URL, and the bus that opens a terminal island from
 * anywhere in the app (composer button, page, command).
 */

export type TerminalSession = {
  id: string;
  /** `project:<slug>`, `agent:<name>`, or null (no context). */
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

export type TerminalUnavailableReason = 'unauthorized' | 'session_required' | 'forbidden' | 'disabled' | 'pty_unavailable';

export type TerminalStatus =
  | { enabled: true; sessions: TerminalSession[] }
  | { enabled: false; reason: TerminalUnavailableReason; sessions: [] };

export async function fetchTerminalStatus(signal?: AbortSignal): Promise<TerminalStatus> {
  const r = await fetch('/api/ui/terminal/web', { cache: 'no-store', signal });
  if (r.status === 401) return { enabled: false, reason: 'unauthorized', sessions: [] };
  // An older daemon without the module answers 404: say "disabled", not an error.
  if (r.status === 404) return { enabled: false, reason: 'disabled', sessions: [] };
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json() as TerminalStatus;
}

/**
 * What a terminal belongs to: the project of the current view, or the agent
 * when it has no project. Null: no context (cockpit, a page of its own).
 */
export type TerminalScope = { kind: 'project'; slug: string } | { kind: 'agent'; name: string };

/** Same key as the daemon stores on the session. */
export function scopeKey(scope: TerminalScope | null): string | null {
  if (!scope) return null;
  return scope.kind === 'project' ? `project:${scope.slug}` : `agent:${scope.name}`;
}

export function scopeFromKey(key: string | null): TerminalScope | null {
  if (!key) return null;
  if (key.startsWith('project:')) return { kind: 'project', slug: key.slice('project:'.length) };
  if (key.startsWith('agent:')) return { kind: 'agent', name: key.slice('agent:'.length) };
  return null;
}

/** The scope of a view: its project, else its agent, else none. */
export function scopeOfView(project: string | null, agent: string | null): TerminalScope | null {
  if (project) return { kind: 'project', slug: project };
  if (agent) return { kind: 'agent', name: agent };
  return null;
}

export async function createTerminalSession(input: { cwd?: string; cols?: number; rows?: number; scope?: TerminalScope | null }): Promise<TerminalSession> {
  const r = await fetch('/api/ui/terminal/web/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, scope: input.scope ?? undefined }),
  });
  const j = await r.json().catch(() => ({})) as { session?: TerminalSession; error?: string };
  if (!r.ok || !j.session) throw new Error(apiErrorMessage(j, { status: r.status }));
  return j.session;
}

export async function killTerminalSession(id: string): Promise<void> {
  const r = await fetch(`/api/ui/terminal/web/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
}

/** Same origin as the page: the app server proxies the upgrade to the daemon. */
export function terminalStreamUrl(id: string, location: { protocol: string; host: string } = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/api/ui/terminal/web/sessions/${encodeURIComponent(id)}/ws`;
}

/** Last path segment, for a tab label. */
export function cwdLabel(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

/**
 * Bytes a key of the mobile key bar sends. Ctrl+<letter> maps to the C0
 * control code (Ctrl+C = 0x03), the way a physical keyboard does.
 */
export function ctrlSequence(char: string): string | null {
  if (char.length !== 1) return null;
  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  if (char === ' ') return '\u0000';
  if (char === '?') return '\u007f';
  return null;
}

export const KEY_SEQUENCES = {
  esc: '\u001b',
  tab: '\t',
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
  home: '\u001b[H',
  end: '\u001b[F',
} as const;

export const TERMINAL_OPEN_EVENT = 'rooks:terminal-open';

export type TerminalOpenRequest = {
  /**
   * Whose shells. Absent: the scope of the current view. Given (null = the
   * "no context" scope), it must be the scope on screen, compared exactly as
   * the daemon files sessions — unless the view belongs to no project (the
   * multichat grid, the cockpit), which takes the scope named. A project's
   * shells are never opened over another project's view (`openScope`).
   */
  scope?: TerminalScope | null;
  /** Start a new shell in this folder (an agent cwd or a task worktree). */
  cwd?: string;
  /** Or show an existing session; one of another scope falls back to the active shell. */
  sessionId?: string;
  /**
   * Text typed at the prompt of the shell shown (a new one when the scope has
   * none), never followed by Enter: the user reads it and runs it.
   */
  insert?: string;
};

/** The event's detail: the window marks it accepted, synchronously. */
export type TerminalOpenEventDetail = TerminalOpenRequest & { accepted?: boolean };

/**
 * Opens the terminal: a session of the scope shown as an island of the view's
 * workspace (`TerminalOpener`, mounted once at the root of the app). True when
 * the request was taken; false when it was refused: terminal module off, no
 * workspace on this view, a `scope` the view does not take (`openScope`; the
 * view still resolving), or an `insert` holding a control character — a line
 * break would run the command, a tab complete it.
 */
export function openTerminalWindow(request: TerminalOpenRequest = {}): boolean {
  if (request.insert && CONTROL_CHARS.test(request.insert)) return false;
  const detail: TerminalOpenEventDetail = { ...request };
  window.dispatchEvent(new CustomEvent<TerminalOpenEventDetail>(TERMINAL_OPEN_EVENT, { detail }));
  return detail.accepted === true;
}

/**
 * The composer's button: a new shell in `cwd`, filed under the conversation's
 * project (else its agent). That is what a multichat cell needs, its view having
 * no scope of its own. A project unknown so far (`undefined`, not `null`) names
 * nothing rather than claim the agent's scope. A view of another project refuses
 * the scope: the shell then belongs to that view, as an open naming none does,
 * instead of the button doing nothing.
 */
export function openConversationTerminal(cwd: string, agent: { name: string; project?: string | null }): boolean {
  if (agent.project !== undefined && openTerminalWindow({ cwd, scope: scopeOfView(agent.project, agent.name) })) return true;
  return openTerminalWindow({ cwd });
}

export type InsertStep = { kind: 'type'; sessionId: string } | { kind: 'wait' } | { kind: 'create' };

/**
 * Where text waiting to be typed goes: a shell being started (wait for it —
 * an open with a folder is starting the one it is meant for), else the active
 * shell, else the latest one, else a new one.
 */
export function insertStep(sessions: readonly { id: string }[], activeId: string | null, creating: boolean): InsertStep {
  if (creating) return { kind: 'wait' };
  if (activeId && sessions.some((s) => s.id === activeId)) return { kind: 'type', sessionId: activeId };
  const latest = sessions.at(-1);
  return latest ? { kind: 'type', sessionId: latest.id } : { kind: 'create' };
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/;
