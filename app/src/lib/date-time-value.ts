/**
 * The `datetime-local` value shape (`YYYY-MM-DDTHH:mm`, local time) split into
 * a day and an hour and joined back, for the product's date picker. Kept apart
 * from the component so it loads without React.
 */

export const DEFAULT_TIME = '09:00';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DDTHH:mm` → its date and time parts; `null` when it does not parse. */
export function splitLocalValue(value: string): { date: Date; time: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : { date, time: `${m[4]}:${m[5]}` };
}

/** A day and an `HH:mm` → `YYYY-MM-DDTHH:mm`. */
export function joinLocalValue(date: Date, time: string): string {
  const hm = /^\d{2}:\d{2}$/.test(time) ? time : DEFAULT_TIME;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${hm}`;
}
