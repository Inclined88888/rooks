'use client';

import { createContext, useContext, useDeferredValue, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { fetchAgentDetails } from '@/lib/chat-entry';
import { forgetSharedReads, sharedGet } from '@/lib/shared-read';
import { workspaceKeys } from '@/lib/workspace-scope';
import { WORKSPACE_LAYOUT_ROWS, workspaceRoute, workspaceRowHandover, type InitialWorkspace, type WorkspaceRoute } from '@/lib/workspace-route';
import { forgetStoredLayouts, peekStoredLayout, preloadStoredLayout } from '@/hooks/use-stored-layout';
import { announceAccount } from '@/lib/account-change';
import { previousLayoutOwnerOf, workspaceOwnerOf } from '@/lib/machines/acting-account';
import { SWITCH_BUDGET_MS } from '@/lib/chat-mission-preload';

type Workspace = {
  key: string | null;
  /** The view's list of named arrangements, shared by all its projects. Not
   *  derived from `key`: it is a hash of its own (`lib/workspace-scope.ts`). */
  sharedKey: string | null;
  /** On a remote machine, the same list as its rows were hashed before they
   *  followed the acting account (TIM-0137); the presets menu folds it in. */
  previousSharedKey?: string | null;
  /** The view's key as it was hashed then, and the owner it was hashed with:
   *  what the rows of this view, the rail, the strip and the pinned popups
   *  hand over from once (`lib/layout-handover.ts`). */
  previousKey?: string | null;
  previousOwner?: string | null;
  project: string | null;
  view: string;
  owner: string | null;
};
type Resolved = Workspace & { route: string };

/**
 * Workspaces already resolved in this document, by route.
 *
 * This provider is mounted by the root layout and never remounts, so a
 * navigation leaves it with a state describing the PREVIOUS route: the key
 * falls back to `null` for the two chained reads it takes to resolve the new
 * one, and everything scoped paints unscoped in the meantime. A route visited
 * once in this document does not have to be asked for again.
 */
const resolvedRoutes = new Map<string, Resolved>();
/** Account the memory above belongs to. */
let memoryOwner: string | null = null;
/**
 * The account epoch: bumped when the memory stops belonging to the account it
 * was read for (the login page, another owner resolved). A resolution or a
 * read-ahead captures it when it starts and lands nowhere once it changed —
 * a switch's preload started under one account and answered after the logout
 * would otherwise remember that account's route, re-announce it, and seed its
 * rows into the next account's first paint.
 */
let epoch = 0;

function remember(entry: Resolved): void {
  if (entry.owner && entry.owner !== memoryOwner) forget(entry.owner);
  resolvedRoutes.set(entry.route, entry);
}

/** Drops every memorised workspace, and with it the values read under their
 *  scopes: one account's arrangement must never seed another's first paint. */
function forget(owner: string | null): void {
  // Naming the account for the first time (`null` → owner) is no change of
  // account: what is in flight was asked for it, and stays good.
  if (memoryOwner !== null || owner === null) {
    epoch++;
    resolving.clear();
    preloads.clear();
    forgetSharedReads();
  }
  resolvedRoutes.clear();
  forgetStoredLayouts();
  memoryOwner = owner;
  announceAccount(owner);
}

/** Resolutions in flight, by route: the provider and a switch's preload share one. */
const resolving = new Map<string, Promise<Resolved | null>>();

/**
 * The workspace of `view` at `at`: who the account is and, on `/chat`, which
 * project the agent belongs to. `null` when either read fails — a failed
 * identity read must never authorize a layout write.
 */
function resolveRoute(view: string, at: WorkspaceRoute): Promise<Resolved | null> {
  const { agent, explicitProject, route } = at;
  const known = resolving.get(route);
  if (known) return known;
  const started = epoch;
  const read = (async (): Promise<Resolved | null> => {
    try {
      const [auth, agentResponse] = await Promise.all([
        sharedGet('/api/ui/auth/me'),
        agent ? fetchAgentDetails(agent) : null,
      ]);
      if (!auth.ok || (agentResponse && !agentResponse.ok)) return null;
      // The account the ACTIVE machine sees: on a remote one, the device's
      // account there, whose rows its agents and its own interface read.
      const me: unknown = await auth.json();
      const owner = workspaceOwnerOf(me);
      if (!owner) return null;
      const previousOwner = previousLayoutOwnerOf(me);
      const info = agentResponse ? await agentResponse.json() : null;
      const project = agent ? (info?.agent?.project ?? info?.project ?? null) : explicitProject;
      const keys = await workspaceKeys(owner, previousOwner, view, project);
      return started === epoch ? { route, ...keys, previousOwner, project, view, owner } : null;
    } catch {
      return null;
    }
  })().finally(() => { if (resolving.get(route) === read) resolving.delete(route); });
  resolving.set(route, read);
  return read;
}

/** A switch's read-ahead of the next workspace (`preloadWorkspace`). */
interface Preload { at: number; wait: Promise<void>; waited: boolean }
const preloads = new Map<string, Preload>();
/** A settled read-ahead is trusted this long; past it, a switch asks again. */
const PRELOAD_TTL_MS = 5_000;

/** Resolved, and every row its first paint reads is already in memory. */
function readyToPaint(route: string): boolean {
  const entry = resolvedRoutes.get(route);
  return !!entry && WORKSPACE_LAYOUT_ROWS.every(({ suffix }) => peekStoredLayout(`${entry.key}.${suffix}`) !== undefined);
}

/**
 * Resolves the workspace `view?params` will show, and reads the rows its first
 * paint needs, before anything commits it.
 *
 * The provider is mounted once by the root layout: on its own, a switch to a
 * chat of ANOTHER project committed the key `null` for the two reads it takes
 * to learn the new project, then the new key with nothing read under it — the
 * top bar emptied, the islands fell back to their default tree, and the whole
 * screen was painted again (28/10/2026, read as a page reload). Started on the
 * click (`chat-navigation.ts`) and by `ChatRoute`, which suspends the switch on
 * `workspaceWait` so that the previous screen stays until this lands.
 */
export function preloadWorkspace(view: string, params: URLSearchParams, budgetMs = SWITCH_BUDGET_MS, now = Date.now()): void {
  const at = workspaceRoute(view, params);
  if (readyToPaint(at.route)) return;
  const known = preloads.get(at.route);
  if (known && (!known.waited || now - known.at < PRELOAD_TTL_MS)) return;
  const started = epoch;
  const work = resolveRoute(view, at).then(async (entry) => {
    if (!entry || started !== epoch) return;
    remember(entry);
    await Promise.all(WORKSPACE_LAYOUT_ROWS.map(({ suffix, legacy }) => preloadStoredLayout(
      `${entry.key}.${suffix}`,
      workspaceRowHandover(entry.previousKey, suffix, legacy),
    )));
  });
  const preload: Preload = { at: now, wait: Promise.resolve(), waited: false };
  preload.wait = Promise.race([
    work,
    new Promise<void>((resolve) => setTimeout(resolve, budgetMs)),
  ]).then(() => { preload.waited = true; });
  preloads.set(at.route, preload);
}

/**
 * What a switch to `view?params` still has to wait for before its workspace
 * can paint: a promise to suspend on, or `null` once it is resolved and read,
 * or the budget is spent — past it, the screen paints as it always did.
 */
export function workspaceWait(view: string, params: URLSearchParams): Promise<void> | null {
  const { route } = workspaceRoute(view, params);
  if (readyToPaint(route)) return null;
  preloadWorkspace(view, params);
  const preload = preloads.get(route);
  return preload && !preload.waited ? preload.wait : null;
}

const Context = createContext<Workspace>({ key: null, sharedKey: null, project: null, view: '/', owner: null });
export const useWorkspaceLayout = () => useContext(Context);

/** One resolved project for the browser, columns and widgets. Never infer a
 * project from an agent's name: cross-project agents can contain dots too.
 *
 * `initial` is the same answer, computed during the server render (cf.
 * `lib/ui/server-workspace.ts`). It spares the two chained round trips the
 * first paint used to wait on; the client still re-resolves on every route
 * change, and re-resolves this one too if the seed does not describe it. */
export function WorkspaceLayoutProvider({ children, initial }: { children: ReactNode; initial?: InitialWorkspace | null }) {
  // Deferred for the same reason as `ChatRoute`'s address: a chat switch
  // reaches Next's router state at default priority, and the new route, not
  // resolved yet, would commit the key `null` at once — the top bar emptied
  // before the switch's own transition had even started. The deferred render
  // is that transition, held by `ChatRoute` until the workspace is read.
  const view = useDeferredValue(usePathname());
  const params = useDeferredValue(useSearchParams());
  const at = workspaceRoute(view, params);
  const { agent, explicitProject, route } = at;
  // Seeded state, not a seeded effect: the effect runs after the first paint,
  // which is precisely the paint we are trying to get right. A seed for
  // another route is ignored rather than corrected — the effect below will
  // resolve the real one.
  const [state, setState] = useState<Resolved | null>(
    initial && initial.route === route ? initial : null,
  );
  // Derived at render, not seeded into the state: the state initialiser runs
  // once for the life of the document, i.e. never again after the navigation
  // this memory exists for.
  const resolved = state?.route === route ? state : resolvedRoutes.get(route) ?? null;
  useEffect(() => { if (resolved) remember(resolved); }, [resolved]);
  // Logging in is the one boundary every account change goes through, and a
  // memorised route carries the previous account's key.
  // The state goes too: it still holds the last route the previous account
  // resolved, and the next account landing on that same route would be served
  // its key without asking.
  useEffect(() => { if (view === '/login') { forget(null); setState(null); } }, [view]);
  useEffect(() => {
    // Already resolved for this exact route (by the server, or by a previous
    // run): asking again would change nothing and would cost two requests on
    // every mount.
    if (resolved?.route === route) return;
    let alive = true;
    const ask = (): void => {
      const started = epoch;
      void resolveRoute(view, at).then((entry) => {
        if (!alive) return;
        if (entry) setState(entry);
        // The account changed while the answer was on its way: it was dropped,
        // and this route still has to be resolved for the account signed in now.
        else if (started !== epoch) ask();
      });
    };
    ask();
    return () => { alive = false; };
    // `resolved` is read as a guard, not as a dependency: adding it would
    // re-run this effect on every resolution it just performed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, view, agent, explicitProject]);
  // The previous owner goes with the owner: an account-wide row read under
  // one must hand over from the other (`useAccountScope`).
  const value = resolved ?? (view === '/login'
    ? { key: null, sharedKey: null, project: null, view, owner: null, previousOwner: null }
    : { key: null, sharedKey: null, project: null, view, owner: state?.owner ?? null, previousOwner: state?.previousOwner ?? null });
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
