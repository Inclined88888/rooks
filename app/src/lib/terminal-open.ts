/**
 * What an "open the terminal" request does now that there is no terminal
 * window: it finds or starts a shell of the scope and puts that session in the
 * island workspace of the view, as a popup (or a tab of the scope's terminal
 * island). Pure of React and of the DOM: the daemon and the workspace are
 * handed in, so the decision is tested without either.
 */

import type { TerminalOpenRequest, TerminalScope, TerminalSession, TerminalStatus, TerminalUnavailableReason } from './terminal-web';
import { scopeKey } from './terminal-web';

export const TERMINAL_ISLAND_CONTENT = '@timon/terminal-web:session';

export type TerminalOpenDeps = {
  /** The caller's sessions, or why there is no terminal. */
  status: () => Promise<TerminalStatus>;
  /** Starts a shell; without a folder the daemon uses the scope's own. */
  create: (input: { cwd?: string; scope: TerminalScope | null }) => Promise<TerminalSession>;
  /** Puts the session in the workspace of the view (a popup, or a tab of the scope's island). */
  show: (content: { type: string; params: { scope: string | null; sessionId: string } }) => boolean;
  /** Text to type at the session's prompt once it is on screen; never followed by Enter. */
  insert: (sessionId: string, text: string) => void;
};

export type TerminalOpenOutcome =
  | { kind: 'opened'; sessionId: string }
  | { kind: 'unavailable'; reason: TerminalUnavailableReason }
  /** The workspace refused (a limit, a missing type): the user is told by its own toast. */
  | { kind: 'refused'; sessionId: string };

/** The view's terminal scope as `useTerminalScope` reports it. */
export type OpenView =
  | { state: 'pending' }
  | { state: 'ready'; scope: TerminalScope | null; key: string | null };

/**
 * Whose shells an open request may show on this view, or null when it is
 * refused. A request that names no scope takes the view's. One that names a
 * scope is taken when it is the view's own, or when the view belongs to no
 * project or agent at all: the multichat grid, or the cockpit, hosts
 * conversations of every project, and the click came from a card of one of
 * them. A view of another project refuses it: its shells are not mixed with
 * that project's. A view still resolving refuses everything — guessing "none"
 * would open the wrong shells.
 */
export function openScope(
  view: OpenView,
  requested: TerminalScope | null | undefined,
): { scope: TerminalScope | null } | null {
  if (view.state !== 'ready') return null;
  if (requested === undefined) return { scope: view.scope };
  const key = scopeKey(requested);
  if (key === view.key) return { scope: view.scope };
  if (view.key === null) return { scope: requested };
  return null;
}

/**
 * Which session an open shows: the one asked for if it belongs to the scope
 * (another scope's falls back), else a new shell when a folder is given, else
 * the scope's latest live one, else a new shell.
 */
export function pickSession(
  sessions: readonly TerminalSession[],
  scope: string | null,
  request: Pick<TerminalOpenRequest, 'cwd' | 'sessionId'>,
): { kind: 'use'; session: TerminalSession } | { kind: 'create'; cwd?: string } {
  const mine = sessions.filter((s) => (s.scope ?? null) === scope && !s.exited);
  if (request.sessionId) {
    const asked = mine.find((s) => s.id === request.sessionId);
    if (asked) return { kind: 'use', session: asked };
  }
  if (request.cwd) return { kind: 'create', cwd: request.cwd };
  const latest = mine.at(-1);
  return latest ? { kind: 'use', session: latest } : { kind: 'create' };
}

export async function openTerminalSession(
  scope: TerminalScope | null,
  request: Pick<TerminalOpenRequest, 'cwd' | 'sessionId' | 'insert'>,
  deps: TerminalOpenDeps,
): Promise<TerminalOpenOutcome> {
  const status = await deps.status();
  if (!status.enabled) return { kind: 'unavailable', reason: status.reason };
  const key = scopeKey(scope);
  const pick = pickSession(status.sessions, key, request);
  const session = pick.kind === 'use' ? pick.session : await deps.create({ ...(pick.cwd ? { cwd: pick.cwd } : {}), scope });
  // Queued before the island mounts, so the view that mounts finds it waiting.
  if (request.insert) deps.insert(session.id, request.insert);
  const shown = deps.show({ type: TERMINAL_ISLAND_CONTENT, params: { scope: key, sessionId: session.id } });
  return shown ? { kind: 'opened', sessionId: session.id } : { kind: 'refused', sessionId: session.id };
}
