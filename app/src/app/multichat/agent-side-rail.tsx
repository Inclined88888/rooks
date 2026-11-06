'use client';

/**
 * The multichat side bar: the agents to drag into the grid.
 *
 * Agents are grouped by project, projects by pole, bots without a project by
 * team (`lib/multichat-rail.ts`). Every group starts folded — a long list of
 * agents is what the user scrolls past, the one group they work in is what
 * they open — and the browser remembers which ones they opened.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns2, CornerDownLeft, LayoutGrid, PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-react';
import { t } from '@/lib/i18n';
import { STATE_VISUALS } from '@/lib/agent-state';
import { AgentHead, agentIdentity, showsMascot } from '@/components/agent-avatar';
import { cn } from '@/lib/utils';
import {
  RAIL_PREFS_KEY,
  buildRail,
  filterRail,
  firstAgent,
  readRailPrefs,
  type RailGroup,
  type RailPole,
  type RailPrefs,
  type RailTeam,
} from '@/lib/multichat-rail';
import {
  autoColorFor,
  type AgentMeta,
  type ProjectMeta,
} from './types';
import { AGENT_DRAG_TYPE } from './slot-drop-zone';
import { useIslandBus } from '@/lib/island-bus';
import { canDragToIsland, chatSplitActions, startChatIslandDrag } from '@/lib/chat-island-drag';
import { FileContextMenu } from '@/components/chat/file-context-menu';
import { useMultichatGrid } from './grid-hold';
import { RAIL_ICON_BUTTON, type ControlVariant } from './controls';
import { machineScopedStorage } from '@/lib/machines/machine-storage';

type AgentState = 'thinking' | 'idle' | 'needs_action' | 'recent_done' | string;

const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

function loadPrefs(): RailPrefs {
  if (typeof window === 'undefined') return readRailPrefs(null);
  try { return readRailPrefs(machineScopedStorage(window.localStorage).getItem(RAIL_PREFS_KEY)); } catch { return readRailPrefs(null); }
}

/** `⌘B` on a Mac, `Ctrl+B` elsewhere — what the tooltips spell out. */
function toggleShortcut(): string {
  if (typeof navigator === 'undefined') return 'Ctrl+B';
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘B' : 'Ctrl+B';
}

/** Where `/` means a slash, not "search". */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function groupColor(group: RailGroup, project: ProjectMeta | undefined): string {
  if (group.kind === 'project') return project?.color || autoColorFor(group.slug);
  if (group.kind === 'team') return group.color || autoColorFor(group.key);
  return 'hsl(var(--muted-foreground))';
}

export function AgentSideRail({
  agents,
  projectsBySlug,
  poles,
  teams,
  agentStates,
  activeAgentNames,
  hasEmptySlot,
  controls,
  onDragAgent,
  onPlaceAgent,
}: {
  agents: AgentMeta[];
  projectsBySlug: Map<string, ProjectMeta>;
  poles: RailPole[];
  teams: RailTeam[];
  agentStates: Map<string, AgentState>;
  /** Agents already in the grid: shown faded, still draggable (a drop moves
   *  or swaps them). */
  activeAgentNames: Set<string>;
  /** The grid has a free cell: Enter and double-click have somewhere to go. */
  hasEmptySlot: boolean;
  /** Templates menu and grid picker, in the look of the given variant. */
  controls: (variant: ControlVariant) => ReactNode;
  /** Start (a name) or end (null) of a drag from the rail. */
  onDragAgent: (agentName: string | null) => void;
  /** Put the agent in the first empty cell. False when there is none. */
  onPlaceAgent: (agentName: string) => boolean;
}) {
  const [prefs, setPrefs] = useState<RailPrefs>(loadPrefs);
  useEffect(() => {
    try { machineScopedStorage(window.localStorage).setItem(RAIL_PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  }, [prefs]);

  const projects = useMemo(() => Array.from(projectsBySlug.values()), [projectsBySlug]);
  const allSections = useMemo(
    () => buildRail(agents, { projects, poles, teams }),
    [agents, projects, poles, teams],
  );
  // Headings stay put while searching: a pole heading that vanished with the
  // query would reflow the list under the pointer.
  const hasPoles = allSections.some((s) => s.pole);

  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const sections = useMemo(() => filterRail(allSections, query, teams), [allSections, query, teams]);
  // What Enter places: the first match not already on screen.
  const first = useMemo(() => {
    if (!searching) return null;
    const onScreen = activeAgentNames;
    return firstAgent(sections.map((s) => ({
      ...s,
      groups: s.groups.map((g) => ({ ...g, agents: g.agents.filter((a) => !onScreen.has(a.name)) })),
    })));
  }, [searching, sections, activeAgentNames]);
  const resultCount = useMemo(() => sections.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.agents.length, 0), 0), [sections]);

  // A search opens every group that has a match, without touching what the
  // user opened by hand: the groups folded DURING the search live apart and
  // are forgotten with it.
  const [searchFolded, setSearchFolded] = useState<ReadonlySet<string>>(() => new Set());
  const changeQuery = useCallback((next: string) => {
    setQuery(next);
    setSearchFolded(new Set());
  }, []);

  const open = useMemo(() => new Set(prefs.open), [prefs.open]);
  const isOpen = (key: string) => (searching ? !searchFolded.has(key) : open.has(key));
  const visibleKeys = useMemo(() => sections.flatMap((s) => s.groups.map((g) => g.key)), [sections]);
  const anyOpen = visibleKeys.some(isOpen);

  const toggleGroup = (key: string) => {
    if (searching) {
      setSearchFolded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
      return;
    }
    setPrefs((p) => ({
      ...p,
      open: p.open.includes(key) ? p.open.filter((k) => k !== key) : [...p.open, key],
    }));
  };

  const toggleAll = () => {
    if (searching) {
      setSearchFolded(anyOpen ? new Set(visibleKeys) : new Set());
      return;
    }
    setPrefs((p) => {
      const keys = new Set(visibleKeys);
      if (anyOpen) return { ...p, open: p.open.filter((k) => !keys.has(k)) };
      return { ...p, open: [...new Set([...p.open, ...visibleKeys])] };
    });
  };

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const collapsed = prefs.collapsed;
  const setCollapsed = useCallback((next: boolean) => setPrefs((p) => ({ ...p, collapsed: next })), []);
  const shortcut = useMemo(toggleShortcut, []);

  // The search field only exists in the open side bar: asking for it from
  // the folded rail opens the bar first, and the focus follows the render.
  const pendingFocus = useRef(false);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const focusSearch = useCallback(() => {
    if (collapsedRef.current) {
      pendingFocus.current = true;
      setCollapsed(false);
      return;
    }
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [setCollapsed]);
  useEffect(() => {
    if (collapsed || !pendingFocus.current) return;
    pendingFocus.current = false;
    searchRef.current?.focus();
  }, [collapsed]);

  // `/` focuses the search from anywhere on the page, except where it types;
  // Ctrl/⌘+B folds and unfolds the bar, as the side bar of a code editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey) return;
      // A dialog over the page (the agent editor) owns the keyboard.
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'b') {
        if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
        e.preventDefault();
        setCollapsed(!collapsedRef.current);
        return;
      }
      if (e.key !== '/' || e.ctrlKey || e.metaKey || isEditable(e.target)) return;
      e.preventDefault();
      focusSearch();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusSearch, setCollapsed]);

  /** Arrow keys walk the headers and rows, from the search field down. */
  const focusable = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-rail-nav]') ?? []);
  const onListKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = focusable();
    const at = items.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && at === 0) { searchRef.current?.focus(); return; }
    items[Math.min(items.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      // Stop here: Escape must not also close whatever surrounds the page.
      e.preventDefault();
      e.stopPropagation();
      if (query) changeQuery(''); else e.currentTarget.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (first && onPlaceAgent(first.name)) changeQuery('');
    } else if (e.key === 'ArrowDown') {
      const items = focusable();
      const target = searching ? items.find((el) => el.hasAttribute('data-rail-agent')) : items[0];
      if (target) { e.preventDefault(); target.focus(); }
    }
  };

  const asideClass = 'flex h-full shrink-0 flex-col overflow-hidden bg-card/40 backdrop-blur';

  if (collapsed) {
    const expandLabel = t('multichat.rail.expand', { shortcut });
    return (
      <aside id="mc-rail" aria-label={t('multichat.rail.label')} className={cn(asideClass, 'w-11 items-center')}>
        <div role="toolbar" aria-orientation="vertical" aria-label={t('multichat.rail.controls')} className="flex shrink-0 flex-col items-center gap-1 pt-2">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-label={expandLabel}
            title={expandLabel}
            aria-expanded={false}
            aria-controls="mc-rail"
            aria-keyshortcuts="Control+B Meta+B"
            className={RAIL_ICON_BUTTON}
          >
            <PanelLeftOpen className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={focusSearch}
            aria-label={t('multichat.search.label')}
            title={t('multichat.search.label')}
            aria-keyshortcuts="/"
            className={RAIL_ICON_BUTTON}
          >
            <Search className="size-3.5" />
          </button>
          {controls('icon')}
        </div>
        <ul className="mt-3 flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto pb-2">
          {allSections.flatMap((section) => section.groups).map((group, i) => {
            const project = group.slug ? projectsBySlug.get(group.slug) : undefined;
            const color = groupColor(group, project);
            return [
              i > 0 && (
                <li key={`${group.key}:sep`} aria-hidden className="my-1 h-0.5 w-3 shrink-0 rounded-full opacity-60" style={{ background: color }} />
              ),
              ...group.agents.map((a) => (
                <li key={a.name}>
                  <AgentHandle
                    agent={a}
                    onDragAgent={onDragAgent}
                    onPlaceAgent={onPlaceAgent}
                    className={cn('grid size-8 place-items-center rounded-md hover:bg-muted/50', FOCUS_RING, activeAgentNames.has(a.name) && 'opacity-55')}
                  >
                    <AgentAvatar
                      agent={a}
                      project={projectsBySlug.get(a.project ?? '')}
                      color={color}
                      state={agentStates.get(a.name)}
                      className="size-6"
                    />
                  </AgentHandle>
                </li>
              )),
            ];
          })}
        </ul>
      </aside>
    );
  }

  const collapseLabel = t('multichat.rail.collapse', { shortcut });
  return (
    <aside id="mc-rail" aria-label={t('multichat.rail.label')} className={cn(asideClass, 'w-[248px]')}>
      <div role="toolbar" aria-label={t('multichat.rail.controls')} className="flex shrink-0 items-center gap-1.5 px-2 pt-2">
        {controls('full')}
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label={collapseLabel}
          title={collapseLabel}
          aria-expanded
          aria-controls="mc-rail"
          aria-keyshortcuts="Control+B Meta+B"
          className={cn(RAIL_ICON_BUTTON, '-mr-0.5')}
        >
          <PanelLeftClose className="size-3.5" />
        </button>
      </div>

      <div className="shrink-0 px-2 pb-1.5 pt-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            type="text"
            role="searchbox"
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={t('multichat.search.placeholder')}
            aria-label={t('multichat.search.label')}
            aria-keyshortcuts="/"
            aria-controls="mc-rail-list"
            spellCheck={false}
            autoComplete="off"
            className="peer h-7 w-full rounded-md border border-border/60 bg-background/50 pl-7 pr-7 text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/60 focus-visible:ring-1 focus-visible:ring-ring"
          />
          {query ? (
            <button
              type="button"
              onClick={() => { changeQuery(''); searchRef.current?.focus(); }}
              aria-label={t('multichat.search.clear')}
              title={t('multichat.search.clear')}
              className={cn('absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground', FOCUS_RING)}
            >
              <X className="size-3" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 rounded border border-border/70 bg-muted/40 px-1 text-[9.5px] leading-4 text-muted-foreground peer-focus:hidden">
              /
            </kbd>
          )}
        </div>
      </div>

      <div className="flex h-8 shrink-0 items-center gap-2 pl-3 pr-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-foreground">
          {t('multichat.rail.agents')}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {searching ? t('multichat.search.ratio', { count: resultCount, total: agents.length }) : agents.length}
        </span>
        {visibleKeys.length > 0 && (
          <button
            type="button"
            onClick={toggleAll}
            aria-label={anyOpen ? t('multichat.rail.collapseAll') : t('multichat.rail.expandAll')}
            title={anyOpen ? t('multichat.rail.collapseAll') : t('multichat.rail.expandAll')}
            className={cn('ml-auto grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground', FOCUS_RING)}
          >
            {anyOpen ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
          </button>
        )}
      </div>

      <p role="status" className="sr-only">
        {searching ? t('multichat.search.count', { count: resultCount }) : ''}
      </p>
      <div id="mc-rail-list" ref={listRef} onKeyDown={onListKeyDown} className="flex-1 overflow-y-auto pb-2">
        {searching && resultCount === 0 && (
          <p className="px-4 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            {t('multichat.search.none', { query: query.trim() })}
          </p>
        )}
        {sections.map((section) => (
          <section key={section.key} aria-label={section.pole?.name ?? (hasPoles ? t('multichat.rail.otherPole') : undefined)}>
            {hasPoles && (
              <h3 className="px-3 pb-1 pt-3 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                {section.pole?.name ?? t('multichat.rail.otherPole')}
              </h3>
            )}
            {section.groups.map((group) => {
              const project = group.slug ? projectsBySlug.get(group.slug) : undefined;
              const color = groupColor(group, project);
              const expanded = isOpen(group.key);
              const inGrid = group.agents.filter((a) => activeAgentNames.has(a.name)).length;
              const label = group.kind === 'none' ? t('multichat.rail.noProject') : group.label;
              const listId = `mc-rail-${group.key}`;
              return (
                <div key={group.key}>
                  <button
                    type="button"
                    data-rail-nav=""
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={expanded}
                    aria-controls={listId}
                    className={cn('flex w-full items-center gap-2 py-1.5 pl-2.5 pr-3 text-left transition-colors hover:bg-muted/40', FOCUS_RING)}
                  >
                    <ChevronRight
                      className={cn('size-3 shrink-0 text-muted-foreground/70 transition-transform duration-150', expanded && 'rotate-90')}
                    />
                    <span className="inline-block size-1.5 shrink-0 rounded-full" style={{ background: color }} />
                    <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium uppercase tracking-[0.06em] text-foreground/85">
                      {label}
                    </span>
                    {inGrid > 0 && (
                      <LayoutGrid
                        className="size-3 shrink-0 text-primary"
                        aria-label={t('multichat.rail.inGrid', { count: inGrid })}
                        role="img"
                      >
                        <title>{t('multichat.rail.inGrid', { count: inGrid })}</title>
                      </LayoutGrid>
                    )}
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {group.agents.length}
                    </span>
                  </button>
                  {expanded && (
                    <ul id={listId} className="pb-1">
                      {group.agents.map((a) => (
                        <li key={a.name}>
                          <AgentRow
                            agent={a}
                            project={projectsBySlug.get(a.project ?? '')}
                            color={color}
                            state={agentStates.get(a.name)}
                            inUse={activeAgentNames.has(a.name)}
                            primed={first?.name === a.name && hasEmptySlot}
                            onDragAgent={onDragAgent}
                            onPlaceAgent={onPlaceAgent}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}

export function AgentAvatar({
  agent,
  project,
  color,
  state,
  className,
}: {
  agent: AgentMeta;
  project: ProjectMeta | undefined;
  color: string;
  state: AgentState | undefined;
  className?: string;
}) {
  // Same resolution as `AgentAvatar`: the picked head first (docs/AGENT-AVATAR.md).
  const identity = agentIdentity(agent, project);
  const mascot = showsMascot(identity);
  return (
    <span
      className={cn('relative grid shrink-0 place-items-center text-[10px] font-semibold', !mascot && 'rounded-full border bg-background', className)}
      style={mascot ? undefined : { borderColor: color }}
      data-agent-head={mascot ? 'mascot' : 'disc'}
    >
      <span className={cn('grid size-full place-items-center', !mascot && 'overflow-hidden rounded-full')}>
        <AgentHead identity={identity} px={24} glyphClassName="uppercase" glyphStyle={{ color }} />
      </span>
      {(state === 'thinking' || state === 'needs_action') && (
        <span
          className="absolute -right-0.5 -top-0.5 size-2 animate-pulse rounded-full border border-background"
          style={{ background: STATE_VISUALS[state].colorVar }}
        />
      )}
    </span>
  );
}

function AgentRow({
  agent,
  project,
  color,
  state,
  inUse,
  primed,
  onDragAgent,
  onPlaceAgent,
}: {
  agent: AgentMeta;
  project: ProjectMeta | undefined;
  color: string;
  state: AgentState | undefined;
  inUse: boolean;
  /** First search result: Enter in the search field places it. */
  primed: boolean;
  onDragAgent: (agentName: string | null) => void;
  onPlaceAgent: (agentName: string) => boolean;
}) {
  return (
    <AgentHandle
      agent={agent}
      onDragAgent={onDragAgent}
      onPlaceAgent={onPlaceAgent}
      className={cn(
        'flex items-center gap-2 py-1 pl-[26px] pr-3 transition-colors hover:bg-muted/40',
        FOCUS_RING,
        inUse && 'opacity-55',
        primed && 'bg-muted/50',
      )}
    >
      <AgentAvatar agent={agent} project={project} color={color} state={state} className="size-6" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium text-foreground">{agent.name}</span>
        {agent.role && (
          <span className="block truncate text-[9.5px] text-muted-foreground">{agent.role}</span>
        )}
      </span>
      {primed && (
        <CornerDownLeft className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </AgentHandle>
  );
}

/** An agent the user can drag into a cell, or place with Enter / a
 *  double-click in the first empty one. Row of the open bar, avatar of the
 *  folded rail: the same gestures in both. */
function AgentHandle({
  agent,
  onDragAgent,
  onPlaceAgent,
  className,
  children,
}: {
  agent: AgentMeta;
  onDragAgent: (agentName: string | null) => void;
  onPlaceAgent: (agentName: string) => boolean;
  className?: string;
  children: ReactNode;
}) {
  const bus = useIslandBus();
  const grid = useMultichatGrid();
  // "Open in a split": the agent's chat next to the grid, which stays as it is.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const splitActions = chatSplitActions(bus, agent.name);
  return (
    <>
    <div
      data-rail-nav=""
      data-rail-agent=""
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(AGENT_DRAG_TYPE, agent.name);
        e.dataTransfer.effectAllowed = 'move';
        // The same gesture opens the agent's chat in the island workspace
        // (ISLAND-WORKSPACE.md §6), anywhere but over the grid (§13).
        if (canDragToIsland(bus)) startChatIslandDrag(e, agent.name, null, { hold: grid() });
        onDragAgent(agent.name);
      }}
      onDragEnd={() => onDragAgent(null)}
      onDoubleClick={() => onPlaceAgent(agent.name)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPlaceAgent(agent.name); }
        if (splitActions.length > 0 && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom });
        }
      }}
      onContextMenu={splitActions.length > 0 ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); } : undefined}
      aria-label={t('multichat.rail.place', { name: agent.name })}
      title={t('multichat.rail.hint', { name: agent.name })}
      className={cn('cursor-grab active:cursor-grabbing', className)}
    >
      {children}
    </div>
    {menu && splitActions.length > 0 && (
      <FileContextMenu
        x={menu.x}
        y={menu.y}
        label={t('islands.openIn.menu')}
        items={splitActions.map((a) => ({ ...a, icon: <Columns2 className="size-3.5" /> }))}
        onClose={closeMenu}
      />
    )}
    </>
  );
}
