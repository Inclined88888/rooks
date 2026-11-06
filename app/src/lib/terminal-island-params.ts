/**
 * The params of a terminal tab in the island workspace, kept apart from the
 * view so the rule is testable without a terminal.
 */
import type { IslandParams } from './island-tree';
import { createTerminalSession, killTerminalSession, scopeFromKey } from './terminal-web';

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SCOPE = /^(project|agent):.{1,200}$/;

/** `{ scope, sessionId }`: the scope key the daemon filed the session under, and its id.
 *  `{ scope, fresh: true }` stands for a session not started yet. */
export function parseTerminalIslandParams(raw: unknown): IslandParams | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { sessionId, scope, fresh } = raw as Record<string, unknown>;
  if (scope !== null && scope !== undefined && (typeof scope !== 'string' || !SCOPE.test(scope))) return null;
  const scopeKey = typeof scope === 'string' ? scope : null;
  if (sessionId === undefined && fresh === true) return { scope: scopeKey, fresh: true };
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  return { scope: scopeKey, sessionId };
}

export const TERMINAL_ISLAND_KEY = 'session';
export const TERMINAL_ISLAND_TYPE = `@timon/terminal-web:${TERMINAL_ISLAND_KEY}`;

/** The "+" of the tab bar: one more shell of the same scope, in its own folder. */
export async function newTerminalTab(params: IslandParams): Promise<IslandParams | null> {
  const scope = typeof params.scope === 'string' ? params.scope : null;
  try {
    const session = await createTerminalSession({ scope: scopeFromKey(scope) });
    return { scope, sessionId: session.id };
  } catch {
    return null;
  }
}

/** Closing the tab ends its shell, as closing a terminal tab always did. */
export function killTerminalOfTab(params: IslandParams): void {
  if (typeof params.sessionId === 'string') void killTerminalSession(params.sessionId).catch(() => { /* already gone */ });
}
