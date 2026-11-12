/**
 * Type filter of the TO DO widgets: narrow the list to some urgencies.
 *
 * Pure on purpose — the tile only holds the selection, the rules live here and
 * are tested without a DOM.
 */
import { TODO_URGENCIES, type TodoUrgency } from './project-todo-tags';

/** An urgency, or `none` for the untagged ideas (`urgency === null`). */
export type UrgencyFilterKey = TodoUrgency | 'none';

export const URGENCY_FILTER_KEYS: readonly UrgencyFilterKey[] = [...TODO_URGENCIES, 'none'];

type Typed = { urgency?: TodoUrgency | null };

export function urgencyKey(item: Typed): UrgencyFilterKey {
  return item.urgency ?? 'none';
}

/** How many items each key would show, every key present (0 included). */
export function countByUrgency(items: readonly Typed[]): Record<UrgencyFilterKey, number> {
  const counts = Object.fromEntries(URGENCY_FILTER_KEYS.map((k) => [k, 0])) as Record<UrgencyFilterKey, number>;
  for (const item of items) counts[urgencyKey(item)] += 1;
  return counts;
}

/** An empty selection is no filter: everything shows. */
export function filterByUrgency<T extends Typed>(items: readonly T[], selected: ReadonlySet<UrgencyFilterKey>): T[] {
  if (selected.size === 0) return [...items];
  return items.filter((item) => selected.has(urgencyKey(item)));
}

/** Multi-select toggle: returns a new set, the given one is left untouched. */
export function toggleUrgency(selected: ReadonlySet<UrgencyFilterKey>, key: UrgencyFilterKey): Set<UrgencyFilterKey> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * The chips worth drawing: those with something to show, plus the selected
 * ones even at 0 — an active chip must stay reachable to be switched off.
 */
export function visibleUrgencyKeys(
  counts: Record<UrgencyFilterKey, number>,
  selected: ReadonlySet<UrgencyFilterKey>,
): UrgencyFilterKey[] {
  return URGENCY_FILTER_KEYS.filter((k) => counts[k] > 0 || selected.has(k));
}
