import { rowHandover, type LayoutHandover } from './layout-handover';

/**
 * What identifies a workspace in the URL, derived in ONE place.
 *
 * The browser and the server both have to answer "which workspace is this?" —
 * the first from `usePathname` / `useSearchParams`, the second from the URL
 * header the middleware forwards. Two copies of this derivation would drift,
 * and a drift here is invisible: the server would seed the layout of a
 * workspace the client then decides it is not in, and the seeded paint would
 * be quietly replaced by another one. The flash it was meant to remove would
 * come back, only harder to explain.
 */

/**
 * Header carrying the requested URL from the middleware to the server render.
 *
 * It lives here, and not in `middleware.ts`: a server module importing the
 * middleware would drag the edge runtime's imports into the Node bundle for
 * one string.
 */
export const URL_HEADER = 'x-rooks-url';

export type WorkspaceRoute = {
  /** Chat's agent as the URL names it, `null` on every other view — and on a
   *  bare `/chat`, which the page canonicalises to the main agent's name
   *  before anything asks for it (`lib/chat-entry.ts`). */
  agent: string | null;
  /** `?project=`, when the view names its project itself. */
  explicitProject: string | null;
  /** Identity of the route, compared as a whole. */
  route: string;
};

export function workspaceRoute(view: string, params: URLSearchParams): WorkspaceRoute {
  const agent = view === '/chat' ? params.get('agent') : null;
  const explicitProject = params.get('project');
  return { agent, explicitProject, route: JSON.stringify([view, agent, explicitProject]) };
}

/**
 * The rows a view's first paint reads under its workspace key, with the
 * pre-workspace scope each one falls back to while it holds nothing yet
 * (after the same row under the previous key, cf. `workspaceRowHandover`).
 *
 * Read by the server render (`resolveLayoutSeeds`) and by a chat switch that
 * resolves the next workspace before committing (`preloadWorkspace`): one
 * list, so the two cannot drift into a switch that paints a row empty.
 */
export const WORKSPACE_LAYOUT_ROWS: ReadonlyArray<{ suffix: string; legacy?: string }> = [
  { suffix: 'widgets', legacy: 'cockpit' },
  { suffix: 'columns', legacy: 'chat.columns' },
  { suffix: 'appearance', legacy: 'chat.appearance' },
  // The island workspace of the view: without it, a split view would
  // paint the page alone, then jump to its islands once the read lands.
  { suffix: 'islands' },
];

/**
 * A workspace resolved during the server render, handed to the client provider.
 *
 * Declared with the derivation rather than next to the server code that fills
 * it: the client provider needs the shape, and must not reach into a module
 * that imports `next/headers` to get it.
 */
export type InitialWorkspace = {
  route: string;
  key: string;
  /** Where this view's named arrangements are listed, projects confounded
   *  (`lib/workspace-scope.ts`). Resolved here rather than by the menu that
   *  reads it: it is the same hash, one argument apart. */
  sharedKey: string;
  /** The same list hashed with the local session's id, on a remote machine
   *  whose rows used to be (`previousLayoutOwner`, TIM-0137): read once by
   *  the presets menu and folded in. `null` or absent everywhere else. */
  previousSharedKey?: string | null;
  /** `key` hashed the same way, and the owner both were hashed with: the
   *  rows a remote machine's view held before, handed over once by the hook
   *  that reads them (`lib/layout-handover.ts`). */
  previousKey?: string | null;
  previousOwner?: string | null;
  owner: string;
  project: string | null;
  view: string;
};

/**
 * Where the row `<key>.<suffix>` takes its first value from: the same row
 * under the workspace's previous key (consumed), then `shared` (kept).
 */
export function workspaceRowHandover(previousKey: string | null | undefined, suffix: string, shared?: string): LayoutHandover {
  return rowHandover(previousKey ? `${previousKey}.${suffix}` : null, shared);
}
