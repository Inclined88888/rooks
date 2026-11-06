/**
 * The order a person gave the side menu. It lives in the account's menu row
 * (`sharedNavScope`) beside `pinned` and `hidden`:
 *
 * - `order`: the main list, top to bottom — paths (`SlotEntry.key`) and
 *   separators (`NAV_SEPARATOR`, a gap the person placed);
 * - `footer`: the same for the foot of the menu, just above the settings gear.
 *
 * A row written before separators and the foot existed (TODO #456) has an
 * `order` of paths and no `footer`: the chrome's divider then keeps the place
 * it registered, and the keyed entries are poured back into the keyed places.
 * From the first change made since, `footer` is always written (even empty),
 * and the separators are exactly the ones the row lists.
 */

const PATH = /^\/[a-z0-9/_-]{0,63}$/;
/** Paths and separators of one list: room for every page, a few gaps, and the pages of plugins switched off. */
const MAX = 96;

/** A separator in a stored list. Not a path, so it can never name a page. */
export const NAV_SEPARATOR = '---';
/** In the editing list only: the boundary under which entries go to the foot of the menu. */
export const NAV_FOOTER_MARK = '~footer';

export type NavLayout = {
  order: string[];
  /** `null`: the row predates the foot of the menu (its separators are the registered ones). */
  footer: string[] | null;
};

export function isNavPath(token: string | undefined): token is string {
  return typeof token === 'string' && PATH.test(token);
}

/** The id of the `n`-th separator of the menu, unique for the drag and drop. */
export function separatorId(n: number): string {
  return `${NAV_SEPARATOR}${n}`;
}

export function isSeparatorId(id: string): boolean {
  return id.startsWith(NAV_SEPARATOR);
}

/** Paths (once each, across `seen`) and separators; anything malformed is dropped. */
function tokensOf(raw: unknown, seen = new Set<string>()): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const token of raw) {
    if (out.length >= MAX) break;
    if (token === NAV_SEPARATOR) out.push(token);
    else if (typeof token === 'string' && PATH.test(token) && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/** The stored main list (paths and separators); anything malformed is dropped. */
export function orderOf(row: unknown): string[] {
  return navLayoutOf(row).order;
}

/** The stored menu: main list and foot; a path listed twice keeps its first place. */
export function navLayoutOf(row: unknown): NavLayout {
  if (!row || typeof row !== 'object') return { order: [], footer: null };
  const { order, footer } = row as { order?: unknown; footer?: unknown };
  const seen = new Set<string>();
  const main = tokensOf(order, seen);
  return { order: main, footer: Array.isArray(footer) ? tokensOf(footer, seen) : null };
}

/** The row with the menu replaced, every other field (`pinned`, `hidden`) kept. Always writes `footer`: it marks a row whose separators are its own. */
export function withNavLayout(row: unknown, layout: { order: readonly string[]; footer: readonly string[] }): Record<string, unknown> {
  const base = row && typeof row === 'object' ? { ...(row as Record<string, unknown>) } : {};
  const clean = navLayoutOf(layout);
  base.order = clean.order;
  base.footer = clean.footer ?? [];
  return base;
}

/**
 * `defaults` is the registered order. The person's order comes first for the
 * paths it names; whatever it does not know (a plugin installed since) follows
 * in its default order, so a new page lands last instead of vanishing.
 */
export function orderedKeys(defaults: readonly string[], order: readonly string[]): string[] {
  const known = new Set(defaults);
  const placed = order.filter((p) => known.has(p));
  const placedSet = new Set(placed);
  return [...placed, ...defaults.filter((p) => !placedSet.has(p))];
}

/**
 * Entries in the order shown. `keyOf` reads an entry's path (or `undefined`):
 * the entries without one stay where they are, the keyed ones fill the keyed
 * places in the person's order.
 */
export function applyNavOrder<T>(entries: readonly T[], keyOf: (entry: T) => string | undefined, order: readonly string[]): T[] {
  const keyed = entries.filter((e) => keyOf(e) !== undefined);
  if (keyed.length < 2 || order.length === 0) return [...entries];
  const byKey = new Map(keyed.map((e) => [keyOf(e)!, e] as const));
  const wanted = orderedKeys(keyed.map((e) => keyOf(e)!), order).map((k) => byKey.get(k)!);
  let next = 0;
  return entries.map((e) => (keyOf(e) === undefined ? e : wanted[next++]!));
}

/**
 * The order after dropping `path` on the place `target` held among the keyed
 * entries (a drag and drop, by pointer or keyboard); unchanged when either is unknown.
 */
export function moveKey(current: readonly string[], path: string, target: string): string[] {
  const from = current.indexOf(path);
  const to = current.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...current];
  const next = [...current];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** A row of the menu: an entry of `nav.item` (`id` = its path, `null` when it has none) or a separator. */
export type NavRow<T> =
  | { kind: 'entry'; id: string | null; entry: T }
  | { kind: 'separator'; id: string };

/**
 * The menu as shown: its main list and its foot. `keyOf` reads an entry's key:
 * a path, `NAV_SEPARATOR` for the chrome's registered divider, or `undefined`.
 *
 * A path the stored menu does not know (a plugin installed since) lands at the
 * end of the main list, in its registered order, and so does an entry with no
 * path. A path it lists but no entry carries (a plugin switched off) is skipped
 * here and kept in the row, so the plugin comes back to its place.
 */
export function layoutNav<T>(entries: readonly T[], keyOf: (entry: T) => string | undefined, stored: NavLayout): { main: NavRow<T>[]; footer: NavRow<T>[] } {
  let n = 0;
  const entryRow = (entry: T): NavRow<T> => {
    const key = keyOf(entry);
    if (key === NAV_SEPARATOR) return { kind: 'separator', id: separatorId(n++) };
    return { kind: 'entry', id: isNavPath(key) ? key : null, entry };
  };
  if (stored.footer === null) {
    const pathOf = (entry: T) => { const key = keyOf(entry); return isNavPath(key) ? key : undefined; };
    return { main: applyNavOrder(entries, pathOf, stored.order.filter(isNavPath)).map(entryRow), footer: [] };
  }
  const byPath = new Map<string, T>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (isNavPath(key) && !byPath.has(key)) byPath.set(key, entry);
  }
  const placed = new Set<string>();
  const rowsOf = (tokens: readonly string[]): NavRow<T>[] => tokens.flatMap((token): NavRow<T>[] => {
    if (token === NAV_SEPARATOR) return [{ kind: 'separator', id: separatorId(n++) }];
    const entry = byPath.get(token);
    if (entry === undefined || placed.has(token)) return [];
    placed.add(token);
    return [{ kind: 'entry', id: token, entry }];
  });
  const main = rowsOf(stored.order);
  const footer = rowsOf(stored.footer);
  for (const entry of entries) {
    const key = keyOf(entry);
    if (key === undefined || (isNavPath(key) && !placed.has(key))) main.push({ kind: 'entry', id: key ?? null, entry });
  }
  return { main, footer };
}

/**
 * What the menu paints outside of "Customize the menu": hidden entries go,
 * and a separator only shows between two shown entries — one at an end, or
 * right after another, would only widen a gap.
 */
export function visibleNavRows<T>(rows: readonly NavRow<T>[], hidden: readonly string[]): NavRow<T>[] {
  const out: NavRow<T>[] = [];
  let gap = false;
  for (const row of rows) {
    if (row.kind === 'separator') {
      gap = out.length > 0;
      continue;
    }
    if (row.id !== null && hidden.includes(row.id)) continue;
    if (gap) out.push({ kind: 'separator', id: separatorId(out.length) });
    gap = false;
    out.push(row);
  }
  return out;
}

/** The ids of the editing list: the main rows, the foot's boundary, the foot's rows. Entries with no path cannot move. */
export function navEditIds<T>(layout: { main: readonly NavRow<T>[]; footer: readonly NavRow<T>[] }): string[] {
  const ids = (rows: readonly NavRow<T>[]) => rows.flatMap((row) => (row.id === null ? [] : [row.id]));
  return [...ids(layout.main), NAV_FOOTER_MARK, ...ids(layout.footer)];
}

/** The stored lists an editing list stands for. */
export function navLayoutFromIds(ids: readonly string[]): { order: string[]; footer: string[] } {
  const tokens = ids.map((id) => (isSeparatorId(id) ? NAV_SEPARATOR : id));
  const mark = tokens.indexOf(NAV_FOOTER_MARK);
  if (mark < 0) return { order: tokens, footer: [] };
  return { order: tokens.slice(0, mark), footer: tokens.slice(mark + 1).filter((t) => t !== NAV_FOOTER_MARK) };
}

/**
 * `next` with the paths `previous` stored and no entry carries now (`present`
 * holds those that do) put back right after the token they followed: the page
 * of a plugin switched off keeps its place for when it comes back.
 */
export function keepAbsentPaths(previous: NavLayout, next: { order: readonly string[]; footer: readonly string[] }, present: ReadonlySet<string>): { order: string[]; footer: string[] } {
  const before = [...previous.order, NAV_FOOTER_MARK, ...(previous.footer ?? [])];
  const out = [...next.order, NAV_FOOTER_MARK, ...next.footer];
  let cursor = 0;
  for (const token of before) {
    if (token === NAV_SEPARATOR) continue;
    if (token !== NAV_FOOTER_MARK && !present.has(token)) {
      if (!out.includes(token)) out.splice(cursor++, 0, token);
      continue;
    }
    const at = out.indexOf(token);
    if (at >= 0) cursor = at + 1;
  }
  return navLayoutFromIds(out);
}

/**
 * The menu after an agent's proposal (`nav_propose`): `order` replaces the main
 * list, `footer` the foot, and a list left out keeps what the menu shows minus
 * the pages the other one moves. `keys` are those of the registered entries:
 * a row from before the foot is first read as shown, its divider included.
 */
export function proposedNavLayout(
  stored: NavLayout,
  keys: readonly (string | undefined)[],
  proposal: { order?: readonly string[]; footer?: readonly string[] },
): { order: string[]; footer: string[] } {
  const present = new Set(keys.filter(isNavPath));
  const shown = navLayoutFromIds(navEditIds(layoutNav(keys, (k) => k, stored)));
  const current = keepAbsentPaths(stored, shown, present);
  const order = proposal.order ? [...proposal.order] : current.order.filter((t) => !proposal.footer?.includes(t) || t === NAV_SEPARATOR);
  const footer = proposal.footer ? [...proposal.footer] : current.footer.filter((t) => !proposal.order?.includes(t) || t === NAV_SEPARATOR);
  return keepAbsentPaths({ order: current.order, footer: current.footer }, { order, footer }, present);
}
