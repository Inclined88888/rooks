'use client';

/**
 * A terminal session as a content of the island workspace
 * (`@timon/terminal-web:session`, `docs/ISLAND-WORKSPACE.md` §7).
 *
 * It shows ONE session, by id — the island's tabs stand in for the scope's
 * tab strip. The shell lives on the host, so mounting this view again never
 * loses anything. A session gone is shown as ended with a Close button; a new
 * shell is never started behind the user's back (`autoCreate` stays the
 * window's) — except for a tab opened `fresh`, which is that very request: an
 * agent cannot know a session id before the shell exists, so its proposal asks
 * for a new one and the tab starts it once, then keeps its id.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useIslandContent } from '@/components/islands/island-content';
import { t } from '@/lib/i18n';
import { cwdLabel, fetchTerminalStatus } from '@/lib/terminal-web';
import { useTerminalInsert } from '@/lib/terminal-insert';
import { TerminalView } from './terminal-view';
import { newTerminalTab, parseTerminalIslandParams } from '@/lib/terminal-island-params';

export { parseTerminalIslandParams };
export { TERMINAL_ISLAND_KEY, TERMINAL_ISLAND_TYPE, killTerminalOfTab, newTerminalTab } from '@/lib/terminal-island-params';

export function TerminalIsland(): ReactElement {
  const { params, active, close, setTitle, setParams } = useIslandContent();
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  const fresh = params.fresh === true && !sessionId;
  const [ended, setEnded] = useState(false);
  const insert = useTerminalInsert(sessionId);
  const starting = useRef(false);

  useEffect(() => {
    if (!fresh || starting.current) return;
    starting.current = true;
    const scope = typeof params.scope === 'string' ? params.scope : null;
    void newTerminalTab({ scope }).then((next) => {
      if (next) setParams(next);
      else setEnded(true);
    });
  }, [fresh, params.scope, setParams]);

  useEffect(() => {
    if (fresh) return;
    let alive = true;
    setEnded(false);
    void fetchTerminalStatus().then((status) => {
      if (!alive || !status.enabled) return;
      const session = status.sessions.find((s) => s.id === sessionId);
      if (!session) setEnded(true);
      else setTitle(cwdLabel(session.cwd));
    }).catch(() => { /* The view says it on its own when the socket fails. */ });
    return () => { alive = false; };
  }, [fresh, sessionId, setTitle]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {sessionId && <TerminalView key={sessionId} sessionId={sessionId} active={active} insert={insert} onEnded={() => setEnded(true)} />}
      </div>
      {ended && (
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground">
          <span>{t('terminal.state.ended')}</span>
          <button type="button" onClick={close} className="rounded-md bg-muted px-2.5 py-1 text-foreground hover:bg-muted/70">
            {t('islands.close')}
          </button>
        </div>
      )}
    </div>
  );
}
