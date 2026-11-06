/**
 * Tabs the user closed in the top bar's agent strip.
 *
 * A closed tab stays closed for the work that was there when it was closed,
 * and comes back once the agent starts a mission after that. The feed shows
 * ONE mission per agent, and an agent with several (a coder running a task
 * while it pilots a series, two open chats) changes which one it shows from
 * poll to poll: keyed on the shown mission, a closed tab came back within
 * seconds (TODO #338). Keyed on the mission's start, it does not.
 *
 * One store for every strip mounted (the top bar mounts one per breakpoint),
 * persisted in localStorage so a reload keeps the tabs closed, and kept in
 * step with the other windows through the `storage` event.
 */

import { useSyncExternalStore } from 'react';
import type { ActiveAgent } from '@/lib/agent-state';
import { machineKey, machineLocalStorage } from '@/lib/machines/machine-storage';

export type ClosedTab = {
  /** When the tab was closed, on the daemon's clock when known. */
  at: number;
  /** Missions shown under the tab when it was closed: the fallback of a
   *  daemon whose feed carries no `started_at`. */
  missions: string[];
};
export type ClosedTabs = Readonly<Record<string, ClosedTab>>;

export const CLOSED_TABS_LS = 'timon.strip.closed';
/** Agents remembered at most; the oldest closes are dropped first. */
export const MAX_CLOSED_TABS = 200;
const MAX_MISSIONS_PER_TAB = 20;

type TabAgent = Pick<ActiveAgent, 'name' | 'mission_id' | 'started_at'>;

export function parseClosedTabs(raw: string | null): ClosedTabs {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Array<[string, ClosedTab]> = [];
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (name === '__proto__' || !value || typeof value !== 'object') continue;
    const { at, missions } = value as { at?: unknown; missions?: unknown };
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    out.push([name, {
      at,
      missions: Array.isArray(missions) ? missions.filter((m): m is string => typeof m === 'string' && m !== '') : [],
    }]);
  }
  return Object.fromEntries(out);
}

/** True while the tab stays closed: the mission shown is not newer than the close. */
export function isTabClosed(tabs: ClosedTabs, agent: TabAgent): boolean {
  const closed = Object.hasOwn(tabs, agent.name) ? tabs[agent.name] : undefined;
  if (!closed) return false;
  if (typeof agent.started_at === 'number') return agent.started_at <= closed.at;
  return closed.missions.includes(agent.mission_id);
}

export function closeTab(tabs: ClosedTabs, agent: TabAgent, at: number): ClosedTabs {
  const prev = Object.hasOwn(tabs, agent.name) ? tabs[agent.name] : undefined;
  const missions = [...(prev?.missions ?? []).filter((m) => m !== agent.mission_id), agent.mission_id]
    .filter(Boolean)
    .slice(-MAX_MISSIONS_PER_TAB);
  // Never before the start of the mission being closed, whatever the clocks say.
  const entry: ClosedTab = { at: Math.max(at, agent.started_at ?? 0), missions };
  const rest = Object.entries(tabs).filter(([name]) => name !== agent.name);
  return Object.fromEntries([...rest, [agent.name, entry]].slice(-MAX_CLOSED_TABS));
}

/** Drops the closes a newer mission has overridden: once back, a tab stays
 *  back, even when the feed returns to a mission older than the close. */
export function reopenedTabs(tabs: ClosedTabs, agents: readonly TabAgent[]): string[] {
  return agents
    .filter((a) => Object.hasOwn(tabs, a.name) && !isTabClosed(tabs, a))
    .map((a) => a.name);
}

export function withoutTabs(tabs: ClosedTabs, names: readonly string[]): ClosedTabs {
  const drop = new Set(names);
  return Object.fromEntries(Object.entries(tabs).filter(([name]) => !drop.has(name)));
}

// ── Shared store ──────────────────────────────────────────────────────────

const EMPTY: ClosedTabs = {};
let snapshot: ClosedTabs | null = null;
const subscribers = new Set<() => void>();

function read(): ClosedTabs {
  try { return parseClosedTabs(machineLocalStorage()?.getItem(CLOSED_TABS_LS) ?? null); } catch { return EMPTY; }
}

function getSnapshot(): ClosedTabs {
  if (snapshot === null) snapshot = read();
  return snapshot;
}

function notify(): void {
  for (const fn of subscribers) fn();
}

function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== machineKey(CLOSED_TABS_LS)) return;
  snapshot = read();
  notify();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  if (subscribers.size === 1) {
    // A window may have closed tabs while no strip was mounted here.
    snapshot = read();
    window.addEventListener('storage', onStorage);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) window.removeEventListener('storage', onStorage);
  };
}

export function updateClosedTabs(change: (tabs: ClosedTabs) => ClosedTabs): void {
  const next = change(getSnapshot());
  if (next === snapshot) return;
  snapshot = next;
  try { machineLocalStorage()?.setItem(CLOSED_TABS_LS, JSON.stringify(next)); } catch { /* quota: closed for this session only */ }
  notify();
}

export function useClosedTabs(): ClosedTabs {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}
