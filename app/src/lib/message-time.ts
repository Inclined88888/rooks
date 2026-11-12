/**
 * Timestamp shown next to a chat message.
 *
 * The time alone is ambiguous as soon as the thread is reopened on another
 * day (TIM-0069): a message from yesterday at 14:32 reads like one from
 * today. Same local day → "14:32"; another day → "8 Oct 14:32"; another
 * year → the year too. Computed in the browser's time zone, like the time
 * that was shown before.
 */

import { formatDate } from './intl';

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatMsgTime(ms: number, now: number = Date.now(), locale?: string): string {
  const d = new Date(ms);
  const today = new Date(now);
  const sameYear = d.getFullYear() === today.getFullYear();
  if (sameYear && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
    return hhmm(d);
  }
  const day = formatDate(d, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }, locale);
  return `${day} ${hhmm(d)}`;
}
