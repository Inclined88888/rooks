'use client';

/**
 * The caller's terminal sessions OF ONE SCOPE as tabs, and the active one on
 * screen. A scope is a project, or an agent without one: the shells of two
 * projects never share a tab strip. Shared by the floating window (scope of
 * the current view) and the `/terminal` page (scope picked there).
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Columns2, Loader2, PanelsTopLeft, Plus, SquareTerminal, X } from 'lucide-react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';
import {
  createTerminalSession,
  cwdLabel,
  fetchTerminalStatus,
  insertStep,
  killTerminalSession,
  scopeKey,
  type TerminalOpenRequest,
  type TerminalScope,
  type TerminalSession,
  type TerminalUnavailableReason,
} from '@/lib/terminal-web';
import { cn } from '@/lib/utils';
import { activateIslandTab, islandTabOf, openInIsland, useIslandBus } from '@/lib/island-bus';
import { startIslandDrag } from '@/lib/island-drag';
import type { DropRegion } from '@/lib/island-tree';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { TerminalView } from './terminal-view';
import { TERMINAL_ISLAND_TYPE } from '@/lib/terminal-island-params';

/** The places "Open in a split" offers, relative to the focused island (§11). */
const SPLIT_EDGES: readonly (DropRegion | 'float')[] = ['right', 'left', 'bottom', 'top', 'center', 'float'];

type Load =
  | { phase: 'loading' }
  | { phase: 'unavailable'; reason: TerminalUnavailableReason }
  | { phase: 'error'; message: string }
  | { phase: 'ready' };

export function TerminalWorkspace({
  scope,
  request,
  onRequestHandled,
  autoCreate = true,
  showKeyBar = false,
  active = true,
}: {
  /** Whose shells: a project, an agent without project, or none. Mount one
   *  workspace per scope (`key`): it does not follow a change of scope. */
  scope: TerminalScope | null;
  /** A new open request (new shell in a folder, or an existing session), and text to type at its prompt. */
  request?: (Pick<TerminalOpenRequest, 'cwd' | 'sessionId' | 'insert'> & { nonce: number }) | null;
  /** Called once the request is acted on, so a later mount does not replay it. */
  onRequestHandled?: () => void;
  /** Start a shell when the user has none. */
  autoCreate?: boolean;
  showKeyBar?: boolean;
  /** False while the surface is hidden: the views do not refit. */
  active?: boolean;
}): ReactElement {
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const handledNonce = useRef<number | null>(null);
  const autoCreated = useRef(false);
  /** Text to type, tagged with its shell: a view mounted later for another tab must not type it. */
  const [insert, setInsert] = useState<{ nonce: number; text: string; sessionId: string } | null>(null);
  const insertNonce = useRef(0);
  /** Text an open request asked to type, until a shell is there to take it. */
  const [pendingInsert, setPendingInsert] = useState<string | null>(null);
  const key = scopeKey(scope);
  const bus = useIslandBus();
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const refresh = useCallback(async (): Promise<TerminalSession[] | null> => {
    try {
      const status = await fetchTerminalStatus();
      if (!status.enabled) {
        setLoad({ phase: 'unavailable', reason: status.reason });
        setSessions([]);
        return null;
      }
      const mine = status.sessions.filter((s) => (s.scope ?? null) === key);
      setSessions(mine);
      setLoad({ phase: 'ready' });
      setActiveId((current) => current && mine.some((s) => s.id === current)
        ? current
        : mine.at(-1)?.id ?? null);
      return mine;
    } catch (err) {
      setLoad({ phase: 'error', message: (err as Error).message });
      return null;
    }
  }, [key]);

  const create = useCallback(async (cwd?: string): Promise<TerminalSession | null> => {
    setCreating(true);
    try {
      // Without a folder, the daemon starts the shell in the scope's own one.
      const session = await createTerminalSession({ ...(cwd ? { cwd } : {}), scope: scopeRef.current });
      setSessions((list) => [...list, session]);
      setActiveId(session.id);
      return session;
    } catch (err) {
      toast.error(t('terminal.errors.create', { error: (err as Error).message }));
      return null;
    } finally {
      setCreating(false);
    }
  }, []);

  useEffect(() => {
    void refresh().then((list) => {
      if (!list || list.length > 0 || !autoCreate || autoCreated.current) return;
      // A request with a folder will create its own shell: do not start two.
      if (request?.cwd) return;
      autoCreated.current = true;
      void create();
    });
  }, [refresh, create, autoCreate, request?.cwd]);

  useEffect(() => {
    if (!request || handledNonce.current === request.nonce || load.phase !== 'ready') return;
    handledNonce.current = request.nonce;
    if (request.sessionId) {
      // Another scope's session is not on this strip: the active shell stays.
      if (sessions.some((s) => s.id === request.sessionId)) setActiveId(request.sessionId);
    } else if (request.cwd) void create(request.cwd);
    if (request.insert) setPendingInsert(request.insert);
    onRequestHandled?.();
  }, [request, load.phase, sessions, create, onRequestHandled]);

  useEffect(() => {
    if (pendingInsert === null || load.phase !== 'ready') return;
    const step = insertStep(sessions, activeId, creating);
    if (step.kind === 'wait') return;
    if (step.kind === 'create') {
      // Once: a shell that cannot start drops the text rather than retry forever.
      void create().then((session) => { if (!session) setPendingInsert(null); });
      return;
    }
    setPendingInsert(null);
    setActiveId(step.sessionId);
    setInsert({ nonce: ++insertNonce.current, text: pendingInsert, sessionId: step.sessionId });
  }, [pendingInsert, load.phase, sessions, activeId, creating, create]);

  // Leaving the tab drops what was to be typed there: coming back remounts its
  // view, which would type it a second time.
  useEffect(() => {
    setInsert((pending) => (pending && pending.sessionId !== activeId ? null : pending));
  }, [activeId]);

  const close = useCallback(async (id: string) => {
    try {
      await killTerminalSession(id);
    } catch (err) {
      toast.error(t('terminal.errors.kill', { error: (err as Error).message }));
      return;
    }
    setSessions((list) => {
      const next = list.filter((s) => s.id !== id);
      setActiveId((current) => current === id ? next.at(-1)?.id ?? null : current);
      return next;
    });
  }, []);

  const onEnded = useCallback((id: string) => {
    // Leave the exit message on screen; the tab goes on the next refresh.
    window.setTimeout(() => {
      setSessions((list) => list.filter((s) => s.id !== id));
      setActiveId((current) => current === id ? null : current);
      void refresh();
    }, 4_000);
  }, [refresh]);

  if (load.phase === 'loading') {
    return <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>;
  }
  if (load.phase === 'unavailable' || load.phase === 'error') {
    const message = load.phase === 'error'
      ? t('terminal.errors.load', { error: load.message })
      : t(`terminal.unavailable.${load.reason}`, { settingsPath: settingsPath('interface', 'terminal') });
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <SquareTerminal className="size-6" />
        <p className="max-w-sm">{message}</p>
      </div>
    );
  }

  const current = sessions.find((s) => s.id === activeId) ?? null;
  // A session shown in an island is not attached a second time here: a pty
  // has one size, and two views of different widths would fight over it (§7).
  const inIsland = (id: string) => islandTabOf(bus, TERMINAL_ISLAND_TYPE, (p) => p.sessionId === id);
  const currentIslandTab = current ? inIsland(current.id) : null;
  // A tab is dragged into the workspace of the view (§6); no split below 768 px.
  const draggable = bus.present && !bus.narrow;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto px-1.5 py-1" role="tablist" aria-label={t('terminal.tabs')}>
        {sessions.map((s) => (
          <div
            key={s.id}
            draggable={draggable}
            onDragStart={draggable ? (e) => {
              startIslandDrag(e, { type: TERMINAL_ISLAND_TYPE, params: { scope: key, sessionId: s.id } }, { label: cwdLabel(s.cwd) });
            } : undefined}
            className={cn(
              'group flex shrink-0 items-center gap-1 rounded-md pl-2 pr-1 text-xs transition-colors',
              s.id === activeId ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={s.id === activeId}
              title={s.cwd}
              onClick={() => setActiveId(s.id)}
              className="flex max-w-40 items-center gap-1 truncate py-1"
            >
              {inIsland(s.id) && (
                <PanelsTopLeft aria-label={t('terminal.island.marker')} className="size-3 shrink-0 text-primary" />
              )}
              <span className="truncate">{cwdLabel(s.cwd)}</span>
            </button>
            {bus.present && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={t('islands.openIn.menu')}
                  title={t('islands.openIn.menu')}
                  className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
                >
                  <Columns2 className="size-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {(bus.narrow ? (['center'] as const) : SPLIT_EDGES).map((edge) => (
                    <DropdownMenuItem
                      key={edge}
                      onSelect={() => { openInIsland({ type: TERMINAL_ISLAND_TYPE, params: { scope: key, sessionId: s.id } }, { edge }); }}
                    >
                      {bus.narrow ? t('islands.openIn.narrow') : t(`islands.openIn.${edge}`)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <button
              type="button"
              aria-label={t('terminal.actions.kill', { name: cwdLabel(s.cwd) })}
              title={t('terminal.actions.kill', { name: cwdLabel(s.cwd) })}
              onClick={() => void close(s.id)}
              className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => void create()}
          disabled={creating}
          aria-label={t('terminal.actions.new')}
          title={t('terminal.actions.new')}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {current && currentIslandTab ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
            <PanelsTopLeft className="size-6" />
            <p>{t('terminal.island.openedThere')}</p>
            <button
              type="button"
              onClick={() => activateIslandTab(currentIslandTab.id)}
              className="rounded-md bg-muted px-3 py-1.5 text-foreground hover:bg-muted/70"
            >
              {t('terminal.island.show')}
            </button>
          </div>
        ) : current ? (
          <TerminalView
            key={current.id}
            sessionId={current.id}
            active={active}
            showKeyBar={showKeyBar}
            insert={insert?.sessionId === current.id ? insert : null}
            onEnded={() => onEnded(current.id)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <button
              type="button"
              onClick={() => void create()}
              disabled={creating}
              className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm hover:bg-muted/70 disabled:opacity-50"
            >
              <Plus className="size-4" />
              {t('terminal.actions.new')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
