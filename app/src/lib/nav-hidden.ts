/**
 * The pages a person took out of the side menu. They live in the account's
 * menu row (`sharedNavScope`), next to `pinned`; a hidden page still opens by
 * its address. An agent proposes the complete list (`nav_propose`, kind `nav`),
 * with or without a layout of the menu, and this browser writes it once the
 * person applies the card.
 */

export const NAV_PROPOSAL_KIND = 'nav';

const PATH = /^\/[a-z0-9/_-]{0,63}$/;
const MAX = 64;

/** The hidden paths stored in a menu row; anything malformed is dropped. */
export function hiddenOf(row: unknown): string[] {
  if (!row || typeof row !== 'object') return [];
  const { hidden } = row as { hidden?: unknown };
  if (!Array.isArray(hidden)) return [];
  return [...new Set(hidden.filter((p): p is string => typeof p === 'string' && PATH.test(p)))].slice(0, MAX);
}

/** The row with `hidden` replaced, every other field (`pinned`) kept. */
export function withHidden(row: unknown, hidden: readonly string[]): Record<string, unknown> {
  const base = row && typeof row === 'object' ? { ...(row as Record<string, unknown>) } : {};
  const clean = hiddenOf({ hidden });
  if (clean.length) base.hidden = clean;
  else delete base.hidden;
  return base;
}

/** Hides a shown page, shows a hidden one. */
export function toggleHidden(row: unknown, path: string): Record<string, unknown> {
  return setHidden(row, path, !hiddenOf(row).includes(path));
}

/**
 * `path` hidden or shown, whatever the row says now. What a click asks for
 * once it is decided: replayed on a row another window changed (TODO #647),
 * a toggle would undo the very click it stands for.
 */
export function setHidden(row: unknown, path: string, hide: boolean): Record<string, unknown> {
  const current = hiddenOf(row).filter((p) => p !== path);
  return withHidden(row, hide ? [...current, path] : current);
}

const LIST_MAX = 96;
const SEPARATOR = '---';

function tokens(raw: unknown): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > LIST_MAX) return null;
  if (!raw.every((p) => typeof p === 'string' && (p === SEPARATOR || PATH.test(p)))) return null;
  return raw as string[];
}

/**
 * A `nav_propose` payload: at least one of `hidden` (the complete hidden set),
 * `order` (the main list) and `footer` (the foot of the menu), the last two
 * made of paths and `---` separators (`lib/nav-order.ts`).
 */
export function parseNavProposal(raw: unknown): { hidden?: string[]; order?: string[]; footer?: string[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { hidden, order: rawOrder, footer: rawFooter } = raw as { hidden?: unknown; order?: unknown; footer?: unknown };
  const order = tokens(rawOrder);
  const footer = tokens(rawFooter);
  if (order === null || footer === null) return null;
  if (hidden !== undefined) {
    if (!Array.isArray(hidden) || hidden.length > MAX) return null;
    if (!hidden.every((p) => typeof p === 'string' && PATH.test(p))) return null;
  }
  if (hidden === undefined && order === undefined && footer === undefined) return null;
  return {
    ...(hidden !== undefined ? { hidden: [...new Set(hidden as string[])] } : {}),
    ...(order !== undefined ? { order } : {}),
    ...(footer !== undefined ? { footer } : {}),
  };
}
