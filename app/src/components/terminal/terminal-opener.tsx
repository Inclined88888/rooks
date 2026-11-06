'use client';

/**
 * "Open the terminal", mounted once at the root of the app. It has no window
 * any more: a terminal is a session shown as an island (`terminal-island.tsx`),
 * so asking for one puts a session of the scope in the workspace of the view —
 * a popup, or a tab of the scope's terminal island — like any other content.
 *
 * Only a user's gesture asks (composer button, page, the "Paste into a
 * terminal" of a conversation card): a command an agent suggests never opens
 * one by itself. Mounted from the root layout rather than the `overlay` slot,
 * which only the `(main)` frame paints: the chat, where the button lives,
 * renders outside it.
 */

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { isModuleOn, useCapabilities } from '@/lib/capabilities';
import { openInIsland, useIslandBus } from '@/lib/island-bus';
import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';
import { openScope, openTerminalSession } from '@/lib/terminal-open';
import { queueTerminalInsert } from '@/lib/terminal-insert';
import {
  createTerminalSession,
  fetchTerminalStatus,
  TERMINAL_OPEN_EVENT,
  type TerminalOpenEventDetail,
} from '@/lib/terminal-web';
import { useTerminalScope } from './use-terminal-scope';

export function TerminalOpener(): null {
  const caps = useCapabilities();
  const on = isModuleOn(caps, '@timon/terminal-web');
  const view = useTerminalScope();
  const bus = useIslandBus();
  const viewRef = useRef(view);
  viewRef.current = view;
  const present = useRef(bus.present);
  present.current = bus.present;

  useEffect(() => {
    if (!on) return;
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<TerminalOpenEventDetail>).detail ?? {};
      const target = openScope(viewRef.current, detail.scope);
      if (!target) return;
      // No workspace on this view yet: nothing to show a terminal in.
      if (!present.current) return;
      detail.accepted = true;
      void openTerminalSession(target.scope,{ cwd: detail.cwd, sessionId: detail.sessionId, insert: detail.insert }, {
        status: () => fetchTerminalStatus(),
        create: (input) => createTerminalSession(input),
        show: (content) => openInIsland(content, { edge: 'float' }),
        insert: queueTerminalInsert,
      }).then((outcome) => {
        if (outcome.kind === 'unavailable') toast.error(t(`terminal.unavailable.${outcome.reason}`, { settingsPath: settingsPath('interface', 'terminal') }));
      }).catch((err: Error) => {
        toast.error(t('terminal.errors.create', { error: err.message }));
      });
    };
    window.addEventListener(TERMINAL_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(TERMINAL_OPEN_EVENT, onOpen);
  }, [on]);

  return null;
}
