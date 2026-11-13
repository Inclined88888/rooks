'use client';

/**
 * Stored values read during the server render, indexed by their scope.
 *
 * A context and not a chain of props: what needs a seed is `useStoredLayout`,
 * and its callers sit anywhere — the widget host on the root layout, the chat's
 * columns deep inside a page, a plugin's card mounted by a slot. Threading a
 * prop down to each of them would mean touching every component in between for
 * a value none of them uses.
 *
 * Empty by default, which is the state every consumer already handled: no
 * seed simply means the first paint shows the defaults, exactly as before.
 */

import React, { createContext, useContext, type ReactNode } from 'react';

export type LayoutSeeds = Readonly<Record<string, unknown>>;

/** The rail's scope, derived by the server render for the session's account. */
export type NavScopeSeed = { owner: string; scope: string } | null;

const Context = createContext<LayoutSeeds>({});
const NavContext = createContext<NavScopeSeed>(null);

export function LayoutSeedsProvider({ seeds, navScope = null, children }: { seeds: LayoutSeeds; navScope?: NavScopeSeed; children?: ReactNode }) {
  return (
    <Context.Provider value={seeds}>
      <NavContext.Provider value={navScope}>{children}</NavContext.Provider>
    </Context.Provider>
  );
}

/**
 * The rail scope the server derived for `owner`, or `null`.
 *
 * The client derives it with an async hash, which only answers after
 * hydration: a reloaded page had no scope, so no seed, for its first paint.
 * Another owner's scope is never handed out.
 */
export function useSeededNavScope(owner: string | null): string | null {
  const seed = useContext(NavContext);
  return owner && seed?.owner === owner ? seed.scope : null;
}

/**
 * The seed for one scope, or `undefined`.
 *
 * `undefined` and `null` say different things and both matter: nothing was
 * read (the server could not, or did not know this scope), versus the scope
 * was read and holds nothing. Only the second one is a seed — the first must
 * leave the consumer on its defaults.
 */
export function useLayoutSeed(scope: string | null): unknown {
  const seeds = useContext(Context);
  return scope ? seeds[scope] : undefined;
}
