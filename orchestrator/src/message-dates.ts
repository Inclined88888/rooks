/**
 * Dates written into the daemon's own sentences: logs, notifications, the
 * reasons an agent reads.
 *
 * Those sentences are English (AGENTS.md, language rule), so their dates must
 * be too — a hard-coded French locale put "jeu. 30 oct." inside an English line
 * on every tester's machine. The host's own locale is no better: the same line
 * would then read differently from one machine to the next, and a log or a
 * `blocked_reason` is compared across machines. `en-GB` rather than `en-US`:
 * a 24-hour clock and day-before-month, so no "02:05 PM" and no 10/30 vs 30/10
 * ambiguity in a machine-readable reason. The time zone stays the host's.
 */

const TIME_FMT = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

const DATE_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

/** `14:05` — host local time. */
export function messageTime(at: number | Date): string {
  return TIME_FMT.format(at);
}

/** `30 Oct 2026, 14:05` — host local time, month spelled out so the order of
 *  day and month never has to be guessed. */
export function messageDateTime(at: number | Date): string {
  return DATE_TIME_FMT.format(at);
}

/** `Fri 30 Oct` — a day heading. Pass `timeZone: 'UTC'` for a civil-day key
 *  (`YYYY-MM-DD` parsed at noon UTC), which a local zone would shift. */
export function messageDay(at: number | Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', ...(timeZone ? { timeZone } : {}),
  }).format(at);
}
