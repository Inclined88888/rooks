/**
 * What every mascot outside the chat shows (french-ok: the doc heading below is
 * quoted as written in the French maintainers' note): the agent's activity, from ONE
 * source shared by the whole page (docs/AGENT-MASCOT.md, "États vivants hors
 * du chat"). Never a request per avatar:
 *
 * - the active-agents store (`lib/active-agents.ts`: one poll of
 *   `/api/ui/agents/active`, refetched on the stream's state events) says
 *   whether an agent has a live mission, a turn running or a card waiting;
 * - the global stream's `event` frames (`lib/sse-stream.ts`, one EventSource)
 *   say which tool that mission runs, so a busy agent thinks, works or searches;
 * - `task_done` frames make the agent of that task celebrate, briefly.
 *
 * The store starts with its first subscriber and stops with its last: a page
 * without a mascot pays nothing.
 */
import { useSyncExternalStore } from 'react';
import { readActiveAgents, subscribeActiveAgents } from '@/lib/active-agents';
import type { ActiveAgent } from '@/lib/agent-state';
import { sseOn } from '@/lib/sse-stream';
import { activityState, REACTION_MS } from './agent-activity';
import type { MascotState } from './mascot-states';

/** The state of an agent with no row in the active list: no live mission. */
export const RESTING: MascotState = 'sleeping';

/**
 * The state an agent's row shows, given the tool its mission runs (`null`:
 * it writes; `undefined`: unknown). Pure.
 */
export function liveMascotState(row: ActiveAgent | undefined, tool: string | null | undefined): MascotState {
  if (!row) return RESTING;
  if (row.state === 'needs_action') return 'waiting';
  if (row.state === 'thinking') return activityState({ busy: true, tool: tool ?? null, awaitingUser: false }) ?? 'thinking';
  // `idle`: a conversation is open, no turn runs. `done`: its last mission
  // ended a moment ago, nothing is alive any more.
  if (row.state === 'idle' && row.liveness !== 'ended' && row.liveness !== 'interrupted') return 'idle';
  return RESTING;
}

/**
 * What one `event` frame of the global stream says about its mission's tool:
 * the last tool an assistant message calls, `null` once it only writes or its
 * turn ended, `undefined` when the frame says nothing about it. Pure.
 */
export function toolOfFrame(data: string): { missionId: string; tool: string | null } | null {
  let frame: unknown;
  try { frame = JSON.parse(data); } catch { return null; }
  if (!frame || typeof frame !== 'object') return null;
  const { missionId, payload } = frame as { missionId?: unknown; payload?: unknown };
  if (typeof missionId !== 'string' || !payload || typeof payload !== 'object') return null;
  const p = payload as { type?: unknown; message?: { content?: unknown } };
  if (p.type === 'result') return { missionId, tool: null };
  if (p.type !== 'assistant') return null;
  const content = Array.isArray(p.message?.content) ? p.message.content as unknown[] : [];
  let tool: string | null = null;
  let text = false;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; name?: unknown };
    if (b.type === 'tool_use' && typeof b.name === 'string') tool = b.name;
    else if (b.type === 'text') text = true;
  }
  if (tool !== null) return { missionId, tool };
  return text ? { missionId, tool: null } : null;
}

/** The task id of a `task_done` frame, or `null`. */
export function taskOfFrame(data: string): string | null {
  try {
    const id = (JSON.parse(data) as { taskId?: unknown }).taskId;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export type LiveStoreDeps = {
  /** Listens to one event name of the global stream; returns the unsubscribe. */
  onStream(type: string, fn: (data: string) => void): () => void;
  subscribeActive(fn: () => void): () => void;
  readActive(): readonly ActiveAgent[];
  /** The agent a task ran on, or `null`. */
  taskAgent(taskId: string): Promise<string | null>;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
};

export type AgentLiveStore = {
  subscribe(fn: () => void): () => void;
  stateOf(name: string): MascotState;
};

export function createAgentLiveStore(deps: LiveStoreDeps): AgentLiveStore {
  const listeners = new Set<() => void>();
  /** Tool by mission, for the missions of the active list only. */
  const tools = new Map<string, string | null>();
  /** A short reaction by agent, over its activity. */
  const reactions = new Map<string, { state: MascotState; timer: ReturnType<typeof setTimeout> }>();
  let states = new Map<string, MascotState>();
  let previous = new Map<string, MascotState>();
  let stops: Array<() => void> = [];

  const emit = () => { for (const fn of listeners) fn(); };

  const react = (name: string, state: MascotState) => {
    const held = reactions.get(name);
    if (held) deps.clearTimer(held.timer);
    const timer = deps.setTimer(() => { reactions.delete(name); recompute(); }, REACTION_MS);
    reactions.set(name, { state, timer });
  };

  function recompute(): void {
    const rows = deps.readActive();
    const missions = new Set(rows.map((r) => r.mission_id));
    for (const id of tools.keys()) if (!missions.has(id)) tools.delete(id);
    const next = new Map<string, MascotState>();
    for (const row of rows) {
      const state = liveMascotState(row, tools.get(row.mission_id));
      // A turn that ends on the agent's answer: content, briefly.
      const was = previous.get(row.name);
      if ((was === 'thinking' || was === 'working' || was === 'searching') && state === 'idle' && !reactions.has(row.name)) react(row.name, 'happy');
      next.set(row.name, state);
    }
    previous = next;
    const shown = new Map(next);
    for (const [name, r] of reactions) shown.set(name, r.state);
    let changed = shown.size !== states.size;
    if (!changed) for (const [name, s] of shown) if (states.get(name) !== s) { changed = true; break; }
    if (!changed) return;
    states = shown;
    emit();
  }

  function start(): void {
    stops = [
      deps.subscribeActive(recompute),
      deps.onStream('event', (data) => {
        const seen = toolOfFrame(data);
        if (!seen || !deps.readActive().some((r) => r.mission_id === seen.missionId)) return;
        if (tools.get(seen.missionId) === seen.tool) return;
        tools.set(seen.missionId, seen.tool);
        recompute();
      }),
      deps.onStream('task_done', (data) => {
        const id = taskOfFrame(data);
        if (!id) return;
        void deps.taskAgent(id).then((name) => {
          if (!name || listeners.size === 0) return;
          react(name, 'celebrate');
          recompute();
        });
      }),
    ];
    recompute();
  }

  function stop(): void {
    for (const s of stops) s();
    stops = [];
    for (const r of reactions.values()) deps.clearTimer(r.timer);
    reactions.clear();
    tools.clear();
    states = new Map();
    previous = new Map();
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      if (listeners.size === 1) start();
      return () => {
        if (!listeners.delete(fn)) return;
        if (listeners.size === 0) stop();
      };
    },
    stateOf(name) {
      return states.get(name) ?? RESTING;
    },
  };
}

let shared: AgentLiveStore | null = null;

/** The page's one store, wired to the shared stream and active-agents store. */
export function agentLiveStore(): AgentLiveStore {
  shared ??= createAgentLiveStore({
    onStream: (type, fn) => sseOn(type, (event) => fn(typeof event.data === 'string' ? event.data : '')),
    subscribeActive: subscribeActiveAgents,
    readActive: readActiveAgents,
    taskAgent: async (taskId) => {
      try {
        const r = await fetch(`/api/ui/tasks/${encodeURIComponent(taskId)}`, { cache: 'no-store' });
        if (!r.ok) return null;
        const name = ((await r.json()) as { task?: { agent_name?: unknown } }).task?.agent_name;
        return typeof name === 'string' ? name : null;
      } catch {
        return null;
      }
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
  });
  return shared;
}

const noop = () => () => {};
const sleeping = (): MascotState => RESTING;

/**
 * The live state of one agent, or `null` when `name` is `null` (the caller
 * wants the bare look: `live={false}`, a menu). Every avatar of the page reads
 * the same store: N avatars, one subscription to each source.
 */
export function useAgentLiveState(name: string | null, store: AgentLiveStore | null = null): MascotState | null {
  const s = name === null ? null : store ?? agentLiveStore();
  const state = useSyncExternalStore(
    s ? s.subscribe : noop,
    s && name !== null ? () => s.stateOf(name) : sleeping,
    sleeping,
  );
  return name === null ? null : state;
}
