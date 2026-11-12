'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { TopBar } from '@/components/topbar';
import { PageIslandHost } from '@/components/islands/page-island-host';
import { onAgentStateEvent } from '@/lib/active-agents';
import { t } from '@/lib/i18n';
import { AgentSideRail } from './agent-side-rail';
import { ChatSlot } from './chat-slot';
import { LayoutPicker } from './layout-picker';
import { TemplateMenu } from './template-menu';
import { MultichatGridContext } from './grid-hold';
import { openGridInIsland, useIslandBus } from '@/lib/island-bus';
import { chatIslandContent } from '@/lib/chat-island-params';
import { recallAgents, slotsForRecall, type MultichatGrid, type MultichatTemplate } from '@/lib/multichat-templates';
import type { RailPole, RailTeam } from '@/lib/multichat-rail';
import {
  DEFAULT_LAYOUT,
  type AgentMeta,
  type GridLayout,
  type ProjectMeta,
  type Slot,
} from './types';
import { machineScopedStorage } from '@/lib/machines/machine-storage';

const LS_KEY = 'rooks:multichat:state';
type PersistedState = { layout: GridLayout; slots: Slot[] };

type AgentState = 'thinking' | 'idle' | 'needs_action' | 'recent_done' | string;

function makeEmptySlots(count: number): Slot[] {
  return Array.from({ length: count }, () => ({ agentName: null, missionId: null }));
}

function resizeSlots(prev: Slot[], target: number): Slot[] {
  if (prev.length === target) return prev;
  if (prev.length > target) return prev.slice(0, target);
  return [...prev, ...makeEmptySlots(target - prev.length)];
}

/** URL ⇄ state. Format: ?cols=2&rows=2&slots=ROOKS.main:m1,initech.coder,,...
 *  - "," separates slots
 *  - ":" separates agent and mission (mission optional)
 *  - empty entry = empty slot */
function decodeUrl(sp: URLSearchParams): PersistedState | null {
  const colsRaw = sp.get('cols');
  const rowsRaw = sp.get('rows');
  if (!colsRaw && !rowsRaw && !sp.get('slots')) return null;
  const cols = Math.max(1, Math.min(4, parseInt(colsRaw || '2', 10) || 2));
  const rows = Math.max(1, Math.min(4, parseInt(rowsRaw || '2', 10) || 2));
  const total = cols * rows;
  const raw = sp.get('slots') || '';
  const parts = raw ? raw.split(',') : [];
  const slots: Slot[] = makeEmptySlots(total);
  for (let i = 0; i < Math.min(parts.length, total); i++) {
    const p = parts[i];
    if (!p) continue;
    const [agentName, missionId] = p.split(':');
    if (agentName) {
      slots[i] = {
        agentName: decodeURIComponent(agentName),
        missionId: missionId ? decodeURIComponent(missionId) : null,
      };
    }
  }
  return { layout: { cols, rows }, slots };
}

function encodeUrl(state: PersistedState): string {
  const slots = state.slots
    .map((s) => {
      if (!s.agentName) return '';
      const a = encodeURIComponent(s.agentName);
      return s.missionId ? `${a}:${encodeURIComponent(s.missionId)}` : a;
    })
    .join(',');
  return `cols=${state.layout.cols}&rows=${state.layout.rows}&slots=${slots}`;
}

export function MultichatClient() {
  const islandBus = useIslandBus();
  const searchParams = useSearchParams();
  const initial: PersistedState = useMemo(() => {
    // URL first
    const fromUrl = decodeUrl(searchParams);
    if (fromUrl) return fromUrl;
    // localStorage fallback
    if (typeof window !== 'undefined') {
      try {
        const stored = machineScopedStorage(window.localStorage).getItem(LS_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as PersistedState;
          if (parsed.layout && Array.isArray(parsed.slots)) return parsed;
        }
      } catch { /* ignore */ }
    }
    return {
      layout: DEFAULT_LAYOUT,
      slots: makeEmptySlots(DEFAULT_LAYOUT.cols * DEFAULT_LAYOUT.rows),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [layout, setLayoutState] = useState<GridLayout>(initial.layout);
  const [slots, setSlotsState] = useState<Slot[]>(initial.slots);
  // A fresh chat learns its mission later. Keep it without changing the cell's
  // start params/key (which would remount the live ChatClient).
  const liveMissions = useRef(new WeakMap<Slot, string>());

  /** Persist on every change to localStorage + URL (shallow). */
  const skipFirstPersist = useRef(true);
  useEffect(() => {
    if (skipFirstPersist.current) {
      skipFirstPersist.current = false;
      return;
    }
    const state: PersistedState = { layout, slots };
    try {
      machineScopedStorage(window.localStorage).setItem(LS_KEY, JSON.stringify(state));
    } catch { /* ignore */ }
    try {
      const qs = encodeUrl(state);
      const next = `${window.location.pathname}?${qs}`;
      window.history.replaceState({}, '', next);
    } catch { /* ignore */ }
  }, [layout, slots]);

  // ── Data: agents + projects + agent states
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [poles, setPoles] = useState<RailPole[]>([]);
  const [teams, setTeams] = useState<RailTeam[]>([]);
  const [agentStates, setAgentStates] = useState<Map<string, AgentState>>(new Map());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ar, pr] = await Promise.all([
          fetch('/api/ui/agents', { cache: 'no-store' }),
          fetch('/api/ui/projects', { cache: 'no-store' }),
        ]);
        if (!ar.ok || !pr.ok) return;
        const aj = (await ar.json()) as { agents: AgentMeta[] };
        const pj = (await pr.json()) as { projects: ProjectMeta[] };
        if (cancelled) return;
        setAgents((aj.agents ?? []).filter((a) => !a.name.startsWith('_')));
        setProjects(pj.projects ?? []);
      } catch { /* ignore */ }
    })();
    // Poles and teams only group the side bar: without them (a daemon older
    // than the routes, a viewer without access) the list stays by project.
    const optional = async <T,>(url: string, key: string): Promise<T[]> => {
      const r = await fetch(url, { cache: 'no-store' }).catch(() => null);
      if (!r?.ok) return [];
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return Array.isArray(body[key]) ? (body[key] as T[]) : [];
    };
    void optional<RailPole>('/api/ui/workspaces', 'workspaces').then((list) => { if (!cancelled) setPoles(list); });
    void optional<RailTeam>('/api/ui/teams', 'teams').then((list) => { if (!cancelled) setTeams(list); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await fetch('/api/ui/agents/active', { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as { agents: Array<{ name: string; state: string }> };
        if (cancelled) return;
        setAgentStates(new Map(j.agents.map((a) => [a.name, a.state])));
      } catch { /* ignore */ }
    };
    refresh();
    const timer = setInterval(refresh, 4000);
    const stopStateEvents = onAgentStateEvent(() => { void refresh(); });
    return () => {
      cancelled = true;
      clearInterval(timer);
      stopStateEvents();
    };
  }, []);

  const projectsBySlug = useMemo(() => {
    const m = new Map<string, ProjectMeta>();
    for (const p of projects) m.set(p.slug, p);
    return m;
  }, [projects]);

  const agentByName = useMemo(() => {
    const m = new Map<string, AgentMeta>();
    for (const a of agents) m.set(a.name, a);
    return m;
  }, [agents]);

  const activeAgentNames = useMemo(() => {
    const s = new Set<string>();
    for (const sl of slots) if (sl.agentName) s.add(sl.agentName);
    return s;
  }, [slots]);

  // ── Mutations

  const setLayout = useCallback((next: GridLayout) => {
    setLayoutState(next);
    setSlotsState((prev) => resizeSlots(prev, next.cols * next.rows));
  }, []);

  const dropAgentOn = useCallback(
    (agentName: string, slotIndex: number) => {
      setSlotsState((prev) => {
        if (slotIndex < 0 || slotIndex >= prev.length) return prev;
        // Dropped back on its own cell: keep the conversation it holds.
        if (prev[slotIndex]?.agentName === agentName) return prev;
        const out = prev.slice();
        // If agent already exists in another slot → swap with target
        const sourceIdx = out.findIndex((s) => s.agentName === agentName);
        const target = out[slotIndex] ?? { agentName: null, missionId: null };
        if (sourceIdx >= 0 && sourceIdx !== slotIndex) {
          out[sourceIdx] = target;
          out[slotIndex] = { agentName, missionId: null };
        } else {
          out[slotIndex] = { agentName, missionId: null };
        }
        return out;
      });
    },
    [],
  );

  /** Keyboard and double-click path: the first empty cell, if any. An agent
   *  already on screen stays where it is. */
  const placeAgent = useCallback((agentName: string): boolean => {
    const target = slots.findIndex((s) => !s.agentName);
    if (target < 0 || slots.some((s) => s.agentName === agentName)) return false;
    dropAgentOn(agentName, target);
    return true;
  }, [slots, dropAgentOn]);

  const clearSlot = useCallback((slotIndex: number) => {
    setSlotsState((prev) => {
      const out = prev.slice();
      out[slotIndex] = { agentName: null, missionId: null };
      return out;
    });
  }, []);

  const pickMissionInSlot = useCallback((slotIndex: number, missionId: string) => {
    setSlotsState((prev) => {
      const out = prev.slice();
      const cur = out[slotIndex];
      if (!cur) return out;
      out[slotIndex] = { agentName: cur.agentName, missionId };
      return out;
    });
  }, []);

  const resetMissionInSlot = useCallback((slotIndex: number) => {
    setSlotsState((prev) => {
      const out = prev.slice();
      const cur = out[slotIndex];
      if (!cur) return out;
      // Back to picker: drop both mission AND any pending "new conv" intent.
      out[slotIndex] = { agentName: cur.agentName, missionId: null };
      return out;
    });
  }, []);

  const newConversationInSlot = useCallback((slotIndex: number) => {
    setSlotsState((prev) => {
      const out = prev.slice();
      const cur = out[slotIndex];
      if (!cur) return out;
      out[slotIndex] = {
        agentName: cur.agentName,
        missionId: null,
        newConvKey: (cur.newConvKey ?? 0) + 1,
      };
      return out;
    });
  }, []);

  const grid: MultichatGrid = useMemo(
    () => ({ cols: layout.cols, rows: layout.rows, agents: slots.map((s) => s.agentName) }),
    [layout, slots],
  );

  /** An agent already on screen keeps its conversation: switching back and
   *  forth between two setups that share an agent must not drop what it was
   *  doing. The others open on their mission picker. */
  const recallTemplate = useCallback((template: MultichatTemplate) => {
    const names = recallAgents(template, agents.length ? new Set(agents.map((a) => a.name)) : null);
    setLayoutState({ cols: template.cols, rows: template.rows });
    setSlotsState((prev) => slotsForRecall(prev, names));
  }, [agents]);

  const clearAll = useCallback(() => {
    setSlotsState(makeEmptySlots(layout.cols * layout.rows));
  }, [layout]);

  const openWorkspace = useCallback(() => {
    const cells = slots.map((slot) => slot.agentName ? chatIslandContent(slot.agentName, liveMissions.current.get(slot) ?? slot.missionId) : null);
    // Release the original chats only after the entire arrangement is accepted.
    if (openGridInIsland(layout, cells)) clearAll();
  }, [layout, slots, clearAll]);

  // ── Agent drag in progress. It raises a drop layer over every cell, so a
  // drop lands on the cell whatever it holds (cf. `slot-drop-zone.tsx`).
  const [draggingAgent, setDraggingAgent] = useState<string | null>(null);
  useEffect(() => {
    if (!draggingAgent) return;
    // `dragend` is fired at the source, and a source that left the DOM
    // mid-drag (a rail group folded, a cell cleared) never delivers it.
    const end = () => setDraggingAgent(null);
    window.addEventListener('dragend', end, true);
    window.addEventListener('drop', end, true);
    return () => {
      window.removeEventListener('dragend', end, true);
      window.removeEventListener('drop', end, true);
    };
  }, [draggingAgent]);

  // Held by every agent drag of the page: over it, the cells take the drop
  // rather than the island workspace (`grid-hold.ts`).
  const gridRef = useRef<HTMLDivElement>(null);

  // ── Desktop-only gate
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 1024);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  return (
    <MultichatGridContext.Provider value={gridRef}>
    <div className="relative z-[1] flex h-dvh flex-col overflow-hidden">
      <div className="fixed inset-x-0 top-0 z-[6]">
        <TopBar />
      </div>

      {/* The TopBar stays out of the workspace; the grid, its rail included,
          is the route's island — a terminal opens beside the grid, never in
          a cell (§13). */}
      <PageIslandHost>
        {!isDesktop ? (
          <div className="grid h-full place-items-center px-6 pl-[calc(var(--rooks-nav-w)+24px)] text-center">
            <div className="max-w-md">
              <h1 className="text-base font-semibold text-foreground">
                {t('multichat.desktopOnly')}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {t('multichat.mobileHint')} <code>/chat?agent=...</code>.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-1 pl-[var(--rooks-nav-w)] pt-[var(--rooks-topbar-h)]">
            <AgentSideRail
              agents={agents}
              projectsBySlug={projectsBySlug}
              agentStates={agentStates}
              activeAgentNames={activeAgentNames}
              poles={poles}
              teams={teams}
              onDragAgent={setDraggingAgent}
              hasEmptySlot={slots.some((s) => !s.agentName)}
              onPlaceAgent={placeAgent}
              controls={(variant) => (
                <>
                  <TemplateMenu grid={grid} onRecall={recallTemplate} variant={variant} />
                  <LayoutPicker
                    layout={layout}
                    onChange={setLayout}
                    onClear={clearAll}
                    canClear={activeAgentNames.size > 0}
                    onOpenWorkspace={islandBus.present ? openWorkspace : undefined}
                    variant={variant}
                  />
                </>
              )}
            />

            <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-2">
              <div
                ref={gridRef}
                data-multichat-grid=""
                className="grid h-full min-h-0 gap-2"
                style={{
                  gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
                }}
              >
                {slots.map((slot, i) => {
                  const agent = slot.agentName ? agentByName.get(slot.agentName) ?? null : null;
                  const project = agent?.project ? projectsBySlug.get(agent.project) ?? null : null;
                  const state = slot.agentName ? agentStates.get(slot.agentName) : undefined;
                  const needsAction = state === 'needs_action';
                  return (
                    <ChatSlot
                      key={i}
                      slotIndex={i}
                      slot={slot}
                      agent={agent}
                      project={project}
                      needsAction={needsAction}
                      draggingAgent={draggingAgent}
                      swap={!!draggingAgent && !!slot.agentName && slot.agentName !== draggingAgent && activeAgentNames.has(draggingAgent)}
                      onDragAgent={setDraggingAgent}
                      onDropAgent={dropAgentOn}
                      onClear={clearSlot}
                      onPickMission={pickMissionInSlot}
                      onResetMission={resetMissionInSlot}
                      onNewConversation={newConversationInSlot}
                      onMissionChange={(id) => { liveMissions.current.set(slot, id); }}
                    />
                  );
                })}
              </div>
            </main>
          </div>
        )}
      </PageIslandHost>

      <style>{`
        .mc-needs-action {
          animation: mc-pulse-amber 1.4s ease-in-out infinite;
        }
        @keyframes mc-pulse-amber {
          0%, 100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); }
          50% { box-shadow: 0 0 0 6px rgba(245,158,11,0.35); }
        }
      `}</style>
    </div>
    </MultichatGridContext.Provider>
  );
}
