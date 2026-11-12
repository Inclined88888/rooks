/**
 * What the bell's dropdown and the "Notifications" widget list: which kinds of
 * notification, and how many at most. Set from the archive page, stored by the
 * daemon in the account's `ui_layout` rows (the `project-todo.display`
 * pattern) — so every client of the account shows the same list.
 *
 * `/api/prefs` was not reused: its schema is closed (scheme, theme, layout),
 * and widening it is a migration for a value `ui_layout` already holds.
 *
 * The list endpoint has no type filter, so a filtered feed over-fetches up to
 * the server's cap and filters here: the maximum applies AFTER the filter.
 * The badge follows the same filter, counted from the server's per-type
 * `counts` rather than from the rows, which are capped — "Need you only"
 * included: the badge then counts what waits for the user, nothing else.
 */

export type NotificationType = 'action_required' | 'alert' | 'report';

/** Display order of the settings, and the full set a fresh account sees. */
export const NOTIFICATION_TYPES: readonly NotificationType[] = ['action_required', 'alert', 'report'];

/** Daemon layout scope (`^[a-z0-9][a-z0-9._-]{0,63}$`). */
export const NOTIFICATION_PREFS_SCOPE = 'notifications.feed';

export const FEED_MAX_MIN = 5;
export const FEED_MAX_MAX = 100;

/** The server caps `limit` at this; a filtered feed asks for all of it. */
export const FEED_FETCH_CAP = 200;

export type NotificationPrefs = {
  /** Never empty: the last kind cannot be unticked. */
  types: readonly NotificationType[];
  max: number;
  /**
   * "Need you only" (SUG-0048): narrows the list to `action_required` on top
   * of `types`, which it leaves untouched — switching it off gives the chosen
   * kinds back. Absent rather than `false`, so a row stored before the switch
   * reads the same.
   */
  actionOnly?: true;
};

/** Every kind, 15 rows: what the dropdown showed before it had settings. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { types: NOTIFICATION_TYPES, max: 15 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** A typed number brought back into range; anything else is the default. */
export function clampFeedMax(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_NOTIFICATION_PREFS.max;
  return Math.min(FEED_MAX_MAX, Math.max(FEED_MAX_MIN, Math.round(n)));
}

/** The stored row, read defensively: an unreadable or empty list of kinds
 *  falls back to all of them, so the dropdown can never go silently blank. */
export function readNotificationPrefs(raw: unknown): NotificationPrefs {
  if (!isRecord(raw)) return DEFAULT_NOTIFICATION_PREFS;
  const listed = Array.isArray(raw.types) ? raw.types.filter(isNotificationType) : [];
  const types = listed.length > 0 ? NOTIFICATION_TYPES.filter((type) => listed.includes(type)) : NOTIFICATION_TYPES;
  const max = raw.max === undefined ? DEFAULT_NOTIFICATION_PREFS.max : clampFeedMax(raw.max);
  return raw.actionOnly === true ? { types, max, actionOnly: true } : { types, max };
}

export function writeNotificationPrefs(
  prefs: NotificationPrefs,
): { v: 1; types: NotificationType[]; max: number; actionOnly?: true } {
  const clean = readNotificationPrefs(prefs);
  return { v: 1, types: [...clean.types], max: clean.max, ...(clean.actionOnly ? { actionOnly: true as const } : {}) };
}

/** The kinds the surfaces actually list: "Need you only" wins over the ticks. */
export function visibleNotificationTypes(prefs: NotificationPrefs): readonly NotificationType[] {
  return prefs.actionOnly ? ['action_required'] : prefs.types;
}

export function toggleActionOnly(prefs: NotificationPrefs): NotificationPrefs {
  const { actionOnly, ...rest } = prefs;
  return actionOnly ? rest : { ...rest, actionOnly: true };
}

/** Ticks or unticks one kind. Unticking the last one is refused (same prefs
 *  back): an empty dropdown would look like a broken one. */
export function toggleNotificationType(prefs: NotificationPrefs, type: NotificationType): NotificationPrefs {
  const on = prefs.types.includes(type);
  if (on && prefs.types.length === 1) return prefs;
  const next = on ? prefs.types.filter((t) => t !== type) : [...prefs.types, type];
  return { ...prefs, types: NOTIFICATION_TYPES.filter((t) => next.includes(t)) };
}

export function isFeedFiltered(prefs: NotificationPrefs): boolean {
  const visible = visibleNotificationTypes(prefs);
  return NOTIFICATION_TYPES.some((type) => !visible.includes(type));
}

/** How many rows to ask the server for. */
export function feedFetchLimit(prefs: NotificationPrefs): number {
  return isFeedFiltered(prefs) ? FEED_FETCH_CAP : prefs.max;
}

/** The rows the surfaces list: visible kinds only, then the maximum. */
export function applyNotificationPrefs<T extends { type: string }>(items: readonly T[], prefs: NotificationPrefs): T[] {
  const visible = visibleNotificationTypes(prefs);
  return items.filter((n) => isNotificationType(n.type) && visible.includes(n.type)).slice(0, prefs.max);
}

/**
 * The count the bell's badge and the surfaces' headers show: every active
 * notification when nothing is hidden, otherwise the active ones of the
 * visible kinds. Without per-type counts (an older daemon), the server's total
 * is the only honest figure left.
 */
export function visibleNotificationTotal(
  totalActive: number,
  counts: Partial<Record<string, number>> | undefined,
  prefs: NotificationPrefs,
): number {
  if (!isFeedFiltered(prefs) || !counts) return totalActive;
  return visibleNotificationTypes(prefs).reduce((sum, type) => sum + (counts[type] ?? 0), 0);
}
