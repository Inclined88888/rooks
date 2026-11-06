/**
 * Navigation an agent proposes (`ui_navigate`), as this browser follows it.
 *
 * The daemon sends a path and typed parameters; the address is rebuilt HERE
 * from those pieces, so nothing an agent wrote can become another origin, a
 * `javascript:` URL or a smuggled query. `/settings` is a dialog over the page
 * on screen (`?settings=`), not a page: it keeps the current path.
 */
import { SETTINGS_PARAM } from './settings-navigation';

export const NAVIGATE_PROPOSAL_KIND = 'navigate';

export type NavigateProposal = { path: string; params: Record<string, string> };

const PATH = /^\/[a-z0-9/_-]{0,63}$/;
const KEY = /^[a-z]{1,20}$/;
const VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function parseNavigateProposal(raw: unknown): NavigateProposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const { path, params } = raw as { path?: unknown; params?: unknown };
  if (typeof path !== 'string' || !PATH.test(path)) return null;
  const out: Record<string, string> = {};
  if (params !== undefined) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (!KEY.test(k) || typeof v !== 'string' || !VALUE.test(v)) return null;
      out[k] = v;
    }
  }
  return { path, params: out };
}

/** The relative address to push; `current` is the live URL (`window.location.href`). */
export function navigateHref(p: NavigateProposal, current: string): string {
  if (p.path === '/settings') {
    const url = new URL(current);
    if (p.params.section) url.searchParams.set(SETTINGS_PARAM, p.params.section);
    else url.searchParams.set(SETTINGS_PARAM, 'interface');
    return `${url.pathname}${url.search}${url.hash}`;
  }
  const qs = new URLSearchParams(p.params).toString();
  return qs ? `${p.path}?${qs}` : p.path;
}

export const NAVIGATE_EVENT = 'timon:navigate';

/**
 * Asks the root listener (`components/navigate-listener.tsx`) to push an
 * address. A card has no router of its own: the one in the tree is the layout's.
 */
export function requestNavigation(href: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<string>(NAVIGATE_EVENT, { detail: href }));
}

/** SSE event the daemon sends the owner's browsers for a direct navigation. */
export const NAVIGATE_SSE_EVENT = 'ui_navigate';

/** The owner starts a guided tour for a mission (browser session only, `POST /api/navigate/grant`).
 *  The daemon's maximum by default: the developer tour runs eight stops, and a
 *  grant that ran out turns every page back into a card without a word. */
export async function startGuidedTour(missionId: string, minutes = 60): Promise<boolean> {
  const r = await fetch('/api/ui/navigate/grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ missionId, minutes }),
  }).catch(() => null);
  return !!r?.ok;
}

export async function endGuidedTour(): Promise<boolean> {
  const r = await fetch('/api/ui/navigate/grant', { method: 'DELETE' }).catch(() => null);
  return !!r?.ok;
}
