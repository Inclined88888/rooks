/**
 * Turns the schedule of an imported routine (Hermes `cron/jobs.json`, OpenBot
 * `routines[]`, a Timon export) into what a `schedule` trigger takes: a
 * five-field cron and an IANA time zone — or a readable reason to skip it.
 *
 * Pure and dependency-free on purpose: the plugin is written on the SDK alone
 * and bundled on its own, so it cannot borrow the daemon's `cron-parser`. The
 * daemon still validates every trigger it is given; this module only makes
 * sure the import preview never promises a routine the daemon will refuse, and
 * says why in words a user can act on.
 */

/** 0 = Sunday … 6 = Saturday; 7 is Sunday too, as cron reads it. Names are read case-insensitively. */
export type Weekday =
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
  | 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
  | 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

/**
 * Every schedule shape a source adapter may hand over. `time` is a 24-hour
 * `HH:MM` wall-clock time in the routine's time zone.
 */
export type SourceSchedule =
  /** Hermes `cron`, OpenBot custom cron, Timon export. */
  | { kind: 'cron'; expression: string }
  /** Hermes `interval`: every N minutes. */
  | { kind: 'interval'; minutes: number }
  /** Hermes `once`: kept for the preview, not applied in v1. */
  | { kind: 'once'; at: string }
  | { kind: 'hourly'; minute?: number }
  | { kind: 'daily'; time: string }
  /** Monday to Friday. */
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; days: readonly Weekday[]; time: string }
  | { kind: 'monthly'; day: number; time: string };

export type ScheduleMapInput = {
  schedule: SourceSchedule;
  /** IANA name from the source; null or absent when it has none. */
  timezone?: string | null;
  /** Kept as is: imported routines start in the state they had at the source (the maintainer, 02/11/2026). */
  enabledInSource: boolean;
};

/**
 * Where the routine lands. A `schedule` trigger runs at most once a minute; the
 * `ctx.routines` fallback (no time zone) at most every five minutes.
 */
export type ScheduleTarget = 'trigger' | 'routine';

export type MappedSchedule = {
  skipped: false;
  cron: string;
  tz: string | null;
  enabled: boolean;
  warnings: string[];
};

export type SkippedSchedule = {
  skipped: true;
  reason: string;
  enabled: boolean;
  /** A `once` routine's instant, shown in the preview although not applied. */
  onceAt?: string;
  warnings: string[];
};

export type ScheduleMapResult = MappedSchedule | SkippedSchedule;

/** Floor between two runs, in minutes, per target. */
export const MIN_CADENCE_MINUTES: Readonly<Record<ScheduleTarget, number>> = { trigger: 1, routine: 5 };

const MINUTES_PER_DAY = 1440;

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const FULL_DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

type FieldSpec = {
  label: string;
  min: number;
  max: number;
  /** Name → number, for month and day-of-week. */
  names?: Readonly<Record<string, number>>;
  /** `?` means "any" (day of month, day of week). */
  question?: boolean;
  /** Extra tokens accepted as is (`L`, `5L`, `1#2`): they only narrow days, never the cadence. */
  special?: RegExp;
};

const FIELDS: readonly FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31, question: true, special: /^L$/i },
  { label: 'month', min: 1, max: 12, names: Object.fromEntries(MONTH_NAMES.map((n, i) => [n, i + 1])) },
  {
    label: 'day of week', min: 0, max: 7, question: true,
    names: Object.fromEntries(DAY_NAMES.map((n, i) => [n, i])),
    special: /^[0-7]L$|^[0-7]#[1-5]$/i,
  },
];

class CronProblem extends Error {}

function parseValue(raw: string, spec: FieldSpec): number {
  const named = spec.names?.[raw.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d{1,2}$/.test(raw)) throw new CronProblem(`${spec.label}: "${raw}" is not a number`);
  const value = Number(raw);
  if (value < spec.min || value > spec.max) {
    throw new CronProblem(`${spec.label}: ${value} is outside ${spec.min}–${spec.max}`);
  }
  return value;
}

/** The values a field allows (specials excluded: they never widen the cadence). */
function parseField(field: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '') throw new CronProblem(`${spec.label}: empty list item`);
    if (spec.special?.test(part)) continue;
    const [base = '', stepRaw, extra] = part.split('/');
    if (extra !== undefined) throw new CronProblem(`${spec.label}: "${part}" has two steps`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d{1,2}$/.test(stepRaw) || Number(stepRaw) < 1) {
        throw new CronProblem(`${spec.label}: step "${stepRaw}" must be a positive number`);
      }
      step = Number(stepRaw);
    }
    let from: number;
    let to: number;
    if (base === '*' || (base === '?' && spec.question === true)) {
      from = spec.min;
      to = spec.max;
    } else if (base.includes('-')) {
      const [a = '', b = '', more] = base.split('-');
      if (more !== undefined) throw new CronProblem(`${spec.label}: "${base}" is not a range`);
      from = parseValue(a, spec);
      to = parseValue(b, spec);
      if (from > to) throw new CronProblem(`${spec.label}: range "${base}" runs backwards`);
    } else {
      from = parseValue(base, spec);
      // `5/15` reads as "from 5, every 15"; a bare value is just itself.
      to = stepRaw === undefined ? from : spec.max;
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

type ParsedCron = { cron: string; minutes: number[]; hours: number[]; everyDay: boolean; everyHour: boolean };

function parseCron(expression: string): ParsedCron {
  const trimmed = expression.trim().replace(/\s+/g, ' ');
  if (trimmed === '') throw new CronProblem('the expression is empty');
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('@')) {
    const expanded = MACROS[lower];
    if (expanded === undefined) throw new CronProblem(`"${trimmed}" is not a schedule Timon can run`);
    return parseCron(expanded);
  }
  const fields = trimmed.split(' ');
  if (fields.length === 6) {
    // Seconds come first for some parsers and last for others (croniter): reading
    // either guess wrong would run the routine at the wrong time.
    throw new CronProblem('six-field expressions (with seconds) are not supported');
  }
  if (fields.length !== 5) throw new CronProblem(`expected 5 fields, found ${fields.length}`);
  const sets = fields.map((f, i) => parseField(f, FIELDS[i] as FieldSpec));
  const isAny = (i: number) => fields[i] === '*' || fields[i] === '?';
  return {
    cron: trimmed,
    minutes: [...(sets[0] as Set<number>)].sort((a, b) => a - b),
    hours: [...(sets[1] as Set<number>)].sort((a, b) => a - b),
    everyDay: isAny(2) && isAny(3) && isAny(4),
    everyHour: isAny(1),
  };
}

/**
 * Shortest gap between two runs, in minutes. The gap across midnight assumes
 * the next day runs too, which can only make the answer smaller: a cadence
 * that passes here passes in the daemon.
 */
function shortestGap(minutes: readonly number[], hours: readonly number[]): number {
  const times: number[] = [];
  for (const h of hours) for (const m of minutes) times.push(h * 60 + m);
  times.sort((a, b) => a - b);
  const first = times[0];
  const last = times[times.length - 1];
  if (first === undefined || last === undefined) return MINUTES_PER_DAY;
  let gap = first + MINUTES_PER_DAY - last;
  for (let i = 1; i < times.length; i += 1) gap = Math.min(gap, (times[i] as number) - (times[i - 1] as number));
  return gap;
}

function parseTime(time: unknown): { hour: number; minute: number } {
  const match = typeof time === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(time.trim()) : null;
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) throw new CronProblem(`time "${String(time)}" is not a 24-hour HH:MM`);
  return { hour, minute };
}

function weekdayNumber(day: unknown): number {
  if (typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 7) return day % 7;
  if (typeof day === 'string') {
    const name = day.trim().toLowerCase();
    const index = DAY_NAMES.findIndex((short, i) => name === short || name === FULL_DAY_NAMES[i]);
    if (index >= 0) return index;
  }
  throw new CronProblem(`"${String(day)}" is not a day of the week`);
}

/** Hermes interval → the cron that runs at the same rate, aligned on the clock. */
function intervalToCron(minutes: unknown): string {
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1) {
    throw new CronProblem(`interval "${String(minutes)}" is not a whole number of minutes`);
  }
  if (minutes < 60 && 60 % minutes === 0) return minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`;
  if (minutes % 60 === 0 && 24 % (minutes / 60) === 0) {
    const hours = minutes / 60;
    if (hours === 1) return '0 * * * *';
    if (hours === 24) return '0 0 * * *';
    return `0 */${hours} * * *`;
  }
  throw new CronProblem(
    `every ${minutes} minutes has no cron equivalent: only intervals that divide an hour or a day evenly can be imported`,
  );
}

function sourceToCron(schedule: SourceSchedule, warnings: string[]): string {
  switch (schedule.kind) {
    case 'cron':
      if (typeof schedule.expression !== 'string') throw new CronProblem('the expression is missing');
      return schedule.expression;
    case 'interval':
      return intervalToCron(schedule.minutes);
    case 'hourly': {
      const minute = schedule.minute ?? 0;
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw new CronProblem(`minute "${String(minute)}" is outside 0–59`);
      }
      return `${minute} * * * *`;
    }
    case 'daily': {
      const { hour, minute } = parseTime(schedule.time);
      return `${minute} ${hour} * * *`;
    }
    case 'weekdays': {
      const { hour, minute } = parseTime(schedule.time);
      return `${minute} ${hour} * * 1-5`;
    }
    case 'weekly': {
      const { hour, minute } = parseTime(schedule.time);
      if (!Array.isArray(schedule.days) || schedule.days.length === 0) throw new CronProblem('no day of the week given');
      const days = [...new Set(schedule.days.map(weekdayNumber))].sort((a, b) => a - b);
      return `${minute} ${hour} * * ${days.join(',')}`;
    }
    case 'monthly': {
      const { hour, minute } = parseTime(schedule.time);
      const { day } = schedule;
      if (!Number.isInteger(day) || day < 1 || day > 31) throw new CronProblem(`day of month "${String(day)}" is outside 1–31`);
      if (day > 28) warnings.push(`Runs on day ${day} only in the months that have one.`);
      return `${minute} ${hour} ${day} * *`;
    }
    default:
      throw new CronProblem(`unknown schedule kind "${String((schedule as { kind?: unknown }).kind)}"`);
  }
}

/**
 * The canonical IANA name, or null when the runtime does not know it. Offsets
 * (`+02:00`) and abbreviations (`CET` aside, which IANA keeps) are refused: a
 * fixed offset ignores daylight saving, the very thing a zone is for.
 */
export function canonicalTimeZone(raw: string): string | null {
  const name = raw.trim();
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(name) || name.length > 64) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function resolveTimeZone(raw: unknown, sensitive: boolean, warnings: string[]): string | null {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    if (sensitive) warnings.push('No time zone in the source: it runs in the time zone of the machine Timon runs on.');
    return null;
  }
  const tz = typeof raw === 'string' ? canonicalTimeZone(raw) : null;
  if (tz === null) {
    warnings.push(`Unknown time zone "${String(raw)}": it runs in the time zone of the machine Timon runs on.`);
  }
  return tz;
}

/** Maps one routine's schedule. Never throws: a schedule it cannot honour comes back skipped, with the reason. */
export function mapSchedule(input: ScheduleMapInput, target: ScheduleTarget = 'trigger'): ScheduleMapResult {
  const enabled = input.enabledInSource === true;
  const warnings: string[] = [];
  const { schedule } = input;
  const kind = (schedule as { kind?: unknown } | null | undefined)?.kind;
  if (typeof schedule !== 'object' || schedule === null) {
    return { skipped: true, reason: 'Invalid schedule: unknown schedule kind "none".', enabled, warnings };
  }

  if (kind === 'once') {
    const at = (schedule as { at?: unknown }).at;
    const time = typeof at === 'string' ? Date.parse(at) : Number.NaN;
    if (Number.isNaN(time)) return { skipped: true, reason: `one-off run at "${String(at)}" is not a valid date`, enabled, warnings };
    return {
      skipped: true,
      reason: 'One-off runs are not imported yet: shown here so it can be recreated by hand.',
      enabled,
      onceAt: new Date(time).toISOString(),
      warnings,
    };
  }

  let parsed: ParsedCron;
  try {
    parsed = parseCron(sourceToCron(schedule, warnings));
  } catch (err) {
    if (!(err instanceof CronProblem)) throw err;
    return { skipped: true, reason: `Invalid schedule: ${err.message}.`, enabled, warnings };
  }

  const floor = MIN_CADENCE_MINUTES[target];
  const gap = shortestGap(parsed.minutes, parsed.hours);
  if (gap < floor) {
    return {
      skipped: true,
      reason: `Runs every ${gap} minute${gap === 1 ? '' : 's'}; Timon runs a routine at most every ${floor} minute${floor === 1 ? '' : 's'}.`,
      enabled,
      warnings,
    };
  }

  // Every hour of every day at the same minutes: a whole-hour shift of zone
  // changes nothing, so a missing zone is not worth a warning.
  const sensitive = !(parsed.everyHour && parsed.everyDay);
  const tz = target === 'routine' ? null : resolveTimeZone(input.timezone, sensitive, warnings);
  if (target === 'routine' && sensitive && input.timezone) {
    warnings.push(`Time zone "${String(input.timezone)}" dropped: it runs in the time zone of the machine Timon runs on.`);
  }
  return { skipped: false, cron: parsed.cron, tz, enabled, warnings };
}
