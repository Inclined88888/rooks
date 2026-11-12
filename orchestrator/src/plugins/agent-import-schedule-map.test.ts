/**
 * The agent import's schedule mapping (plugins/agent-import/src/schedule-map.ts):
 * one case per source shape, the cadence floors, the time zone, and the inputs
 * it must refuse. Every cron it hands out is checked against the daemon's own
 * trigger schema, so the preview never promises what the daemon will refuse.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CronExpressionParser } from 'cron-parser';
import { scheduleCadenceProblem, scheduleConfigSchema } from '../triggers/schema.js';
import type {
  ScheduleMapResult, ScheduleTarget, SourceSchedule,
} from '../../../plugins/agent-import/src/schedule-map.js';

type ScheduleMap = typeof import('../../../plugins/agent-import/src/schedule-map.js');
// Until the plugin's package.json declares `"type": "module"`, tsx loads the
// file as CommonJS and its exports sit under `default`.
const loaded = await import('../../../plugins/agent-import/src/schedule-map.js') as ScheduleMap & { default?: ScheduleMap };
const { mapSchedule, canonicalTimeZone }: ScheduleMap = loaded.default ?? loaded;

const PARIS = 'Europe/Paris';

function mapped(result: ScheduleMapResult): { cron: string; tz: string | null; warnings: string[] } {
  assert.equal(result.skipped, false, result.skipped ? result.reason : '');
  if (result.skipped) throw new Error('unreachable');
  return result;
}

function skipped(result: ScheduleMapResult): string {
  assert.equal(result.skipped, true, result.skipped ? '' : `mapped to ${result.cron}`);
  if (!result.skipped) throw new Error('unreachable');
  return result.reason;
}

/** What the daemon itself checks when the trigger or the fallback routine is written. */
function assertDaemonAccepts(cron: string, tz: string | null, target: ScheduleTarget): void {
  const config = tz === null ? { cron } : { cron, tz };
  const parsed = scheduleConfigSchema.safeParse(config);
  assert.ok(parsed.success, `trigger schema refuses ${cron} ${tz ?? ''}: ${parsed.success ? '' : parsed.error.message}`);
  assert.equal(scheduleCadenceProblem(cron, tz ?? undefined), null);
  if (target === 'routine') {
    const it = CronExpressionParser.parse(cron);
    let previous = it.next().getTime();
    for (let i = 0; i < 8; i++) {
      const next = it.next().getTime();
      assert.ok(next - previous >= 5 * 60_000, `${cron} ticks under five minutes`);
      previous = next;
    }
  }
}

const shapes: ReadonlyArray<{ name: string; schedule: SourceSchedule; cron: string }> = [
  { name: 'cron as written', schedule: { kind: 'cron', expression: '30 9 * * 1-5' }, cron: '30 9 * * 1-5' },
  { name: 'cron, whitespace collapsed', schedule: { kind: 'cron', expression: '  0   8 * *  mon ' }, cron: '0 8 * * mon' },
  { name: 'cron with names and steps', schedule: { kind: 'cron', expression: '*/10 8-18 * jan-jun mon-fri' }, cron: '*/10 8-18 * jan-jun mon-fri' },
  { name: 'cron with ? and L', schedule: { kind: 'cron', expression: '0 6 L * ?' }, cron: '0 6 L * ?' },
  { name: 'cron with nth weekday', schedule: { kind: 'cron', expression: '0 6 * * 1#2' }, cron: '0 6 * * 1#2' },
  { name: 'cron with Sunday as 7', schedule: { kind: 'cron', expression: '0 10 * * 7' }, cron: '0 10 * * 7' },
  { name: 'cron from/step', schedule: { kind: 'cron', expression: '5/15 * * * *' }, cron: '5/15 * * * *' },
  { name: '@daily macro', schedule: { kind: 'cron', expression: '@daily' }, cron: '0 0 * * *' },
  { name: '@weekly macro', schedule: { kind: 'cron', expression: '@Weekly' }, cron: '0 0 * * 0' },
  { name: '@yearly macro', schedule: { kind: 'cron', expression: '@yearly' }, cron: '0 0 1 1 *' },
  { name: 'interval 15 min', schedule: { kind: 'interval', minutes: 15 }, cron: '*/15 * * * *' },
  { name: 'interval 60 min', schedule: { kind: 'interval', minutes: 60 }, cron: '0 * * * *' },
  { name: 'interval 6 h', schedule: { kind: 'interval', minutes: 360 }, cron: '0 */6 * * *' },
  { name: 'interval 24 h', schedule: { kind: 'interval', minutes: 1440 }, cron: '0 0 * * *' },
  { name: 'hourly, default minute', schedule: { kind: 'hourly' }, cron: '0 * * * *' },
  { name: 'hourly at :45', schedule: { kind: 'hourly', minute: 45 }, cron: '45 * * * *' },
  { name: 'daily', schedule: { kind: 'daily', time: '07:05' }, cron: '5 7 * * *' },
  { name: 'daily, one-digit hour', schedule: { kind: 'daily', time: '7:30' }, cron: '30 7 * * *' },
  { name: 'weekdays', schedule: { kind: 'weekdays', time: '09:00' }, cron: '0 9 * * 1-5' },
  { name: 'weekly, one day', schedule: { kind: 'weekly', days: ['fri'], time: '17:30' }, cron: '30 17 * * 5' },
  { name: 'weekly, several days, mixed, deduplicated', schedule: { kind: 'weekly', days: [7, 'monday', 'Wed' as 'wed', 0], time: '08:00' }, cron: '0 8 * * 0,1,3' },
  { name: 'monthly', schedule: { kind: 'monthly', day: 1, time: '06:00' }, cron: '0 6 1 * *' },
];

for (const { name, schedule, cron } of shapes) {
  test(`schedule-map: ${name} → ${cron}`, () => {
    const result = mapped(mapSchedule({ schedule, timezone: PARIS, enabledInSource: true }));
    assert.equal(result.cron, cron);
    assert.equal(result.tz, PARIS);
    assertDaemonAccepts(result.cron, result.tz, 'trigger');
  });
}

test('schedule-map: the source state is kept as is, mapped or skipped', () => {
  for (const enabledInSource of [true, false]) {
    assert.equal(mapSchedule({ schedule: { kind: 'daily', time: '08:00' }, timezone: PARIS, enabledInSource }).enabled, enabledInSource);
    assert.equal(mapSchedule({ schedule: { kind: 'interval', minutes: 7 }, enabledInSource }).enabled, enabledInSource);
    assert.equal(mapSchedule({ schedule: { kind: 'once', at: '2026-12-01T08:00:00Z' }, enabledInSource }).enabled, enabledInSource);
  }
});

test('schedule-map: once is kept for the preview, never applied', () => {
  const result = mapSchedule({ schedule: { kind: 'once', at: '2026-12-01T09:00:00+01:00' }, timezone: PARIS, enabledInSource: true });
  assert.equal(result.skipped, true);
  if (!result.skipped) return;
  assert.equal(result.onceAt, '2026-12-01T08:00:00.000Z');
  assert.match(result.reason, /One-off/);
  const bad = mapSchedule({ schedule: { kind: 'once', at: 'next tuesday' }, enabledInSource: true });
  assert.match(skipped(bad), /not a valid date/);
  assert.equal((bad as { onceAt?: string }).onceAt, undefined);
});

const cadence: ReadonlyArray<{ name: string; schedule: SourceSchedule; target: ScheduleTarget; ok: boolean }> = [
  { name: 'every minute as a trigger', schedule: { kind: 'cron', expression: '* * * * *' }, target: 'trigger', ok: true },
  { name: 'interval 1 min as a trigger', schedule: { kind: 'interval', minutes: 1 }, target: 'trigger', ok: true },
  { name: 'every minute as a routine', schedule: { kind: 'cron', expression: '* * * * *' }, target: 'routine', ok: false },
  { name: 'every 4 min as a routine', schedule: { kind: 'interval', minutes: 4 }, target: 'routine', ok: false },
  { name: 'every 5 min as a routine', schedule: { kind: 'interval', minutes: 5 }, target: 'routine', ok: true },
  { name: 'two runs 2 min apart as a routine', schedule: { kind: 'cron', expression: '0,2 9 * * *' }, target: 'routine', ok: false },
  { name: 'runs across midnight exactly 5 min apart as a routine', schedule: { kind: 'cron', expression: '0,55 0,23 * * *' }, target: 'routine', ok: true },
  { name: 'runs across midnight 3 min apart as a routine', schedule: { kind: 'cron', expression: '0,57 0,23 * * *' }, target: 'routine', ok: false },
  { name: 'runs across midnight 3 min apart as a trigger', schedule: { kind: 'cron', expression: '0,57 0,23 * * *' }, target: 'trigger', ok: true },
  { name: 'every 10 min as a routine', schedule: { kind: 'cron', expression: '*/10 * * * *' }, target: 'routine', ok: true },
];

for (const { name, schedule, target, ok } of cadence) {
  test(`schedule-map: cadence floor — ${name}`, () => {
    const result = mapSchedule({ schedule, timezone: PARIS, enabledInSource: true }, target);
    if (ok) {
      const { cron, tz } = mapped(result);
      assertDaemonAccepts(cron, tz, target);
    } else {
      assert.match(skipped(result), /at most every 5 minutes/);
    }
  });
}

const invalid: ReadonlyArray<{ name: string; schedule: unknown; reason: RegExp }> = [
  { name: 'interval with no cron equivalent', schedule: { kind: 'interval', minutes: 90 }, reason: /every 90 minutes has no cron equivalent/ },
  { name: 'interval of 7 minutes', schedule: { kind: 'interval', minutes: 7 }, reason: /no cron equivalent/ },
  { name: 'interval of 2 days', schedule: { kind: 'interval', minutes: 2880 }, reason: /no cron equivalent/ },
  { name: 'interval of zero', schedule: { kind: 'interval', minutes: 0 }, reason: /whole number of minutes/ },
  { name: 'fractional interval', schedule: { kind: 'interval', minutes: 2.5 }, reason: /whole number of minutes/ },
  { name: 'interval as a string', schedule: { kind: 'interval', minutes: '30' }, reason: /whole number of minutes/ },
  { name: 'empty cron', schedule: { kind: 'cron', expression: '   ' }, reason: /empty/ },
  { name: 'missing expression', schedule: { kind: 'cron' }, reason: /missing/ },
  { name: 'four fields', schedule: { kind: 'cron', expression: '0 9 * *' }, reason: /expected 5 fields, found 4/ },
  { name: 'six fields', schedule: { kind: 'cron', expression: '0 0 9 * * *' }, reason: /six-field/ },
  { name: 'minute out of range', schedule: { kind: 'cron', expression: '60 9 * * *' }, reason: /minute: 60 is outside 0–59/ },
  { name: 'hour out of range', schedule: { kind: 'cron', expression: '0 24 * * *' }, reason: /hour: 24 is outside 0–23/ },
  { name: 'day of month zero', schedule: { kind: 'cron', expression: '0 9 0 * *' }, reason: /day of month/ },
  { name: 'unknown month name', schedule: { kind: 'cron', expression: '0 9 * foo *' }, reason: /month: "foo"/ },
  { name: 'backwards range', schedule: { kind: 'cron', expression: '0 18-8 * * *' }, reason: /runs backwards/ },
  { name: 'zero step', schedule: { kind: 'cron', expression: '*/0 * * * *' }, reason: /step/ },
  { name: 'double step', schedule: { kind: 'cron', expression: '*/5/2 * * * *' }, reason: /two steps/ },
  { name: 'empty list item', schedule: { kind: 'cron', expression: '0,,5 * * * *' }, reason: /empty list item/ },
  { name: '? outside the day fields', schedule: { kind: 'cron', expression: '? * * * *' }, reason: /minute/ },
  { name: 'unknown macro', schedule: { kind: 'cron', expression: '@reboot' }, reason: /not a schedule Rooks can run/ },
  { name: 'Jenkins hash', schedule: { kind: 'cron', expression: 'H * * * *' }, reason: /minute/ },
  { name: 'daily without a time', schedule: { kind: 'daily' }, reason: /HH:MM/ },
  { name: 'daily at 24:00', schedule: { kind: 'daily', time: '24:00' }, reason: /HH:MM/ },
  { name: 'daily at 9am', schedule: { kind: 'daily', time: '9am' }, reason: /HH:MM/ },
  { name: 'hourly at minute 60', schedule: { kind: 'hourly', minute: 60 }, reason: /outside 0–59/ },
  { name: 'weekly with no day', schedule: { kind: 'weekly', days: [], time: '08:00' }, reason: /no day of the week/ },
  { name: 'weekly with a bad day', schedule: { kind: 'weekly', days: ['mo'], time: '08:00' }, reason: /"mo" is not a day of the week/ },
  { name: 'weekly with day 8', schedule: { kind: 'weekly', days: [8], time: '08:00' }, reason: /not a day of the week/ },
  { name: 'monthly on day 32', schedule: { kind: 'monthly', day: 32, time: '08:00' }, reason: /outside 1–31/ },
  { name: 'unknown kind', schedule: { kind: 'yearly', time: '08:00' }, reason: /unknown schedule kind "yearly"/ },
  { name: 'no schedule at all', schedule: null, reason: /unknown schedule kind/ },
];

for (const { name, schedule, reason } of invalid) {
  test(`schedule-map: skipped — ${name}`, () => {
    const result = mapSchedule({ schedule: schedule as SourceSchedule, timezone: PARIS, enabledInSource: true });
    assert.match(skipped(result), reason);
  });
}

test('schedule-map: monthly past day 28 warns about short months', () => {
  const result = mapped(mapSchedule({ schedule: { kind: 'monthly', day: 31, time: '08:00' }, timezone: PARIS, enabledInSource: true }));
  assert.equal(result.cron, '0 8 31 * *');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /day 31 only in the months/);
});

const zones: ReadonlyArray<{ name: string; timezone: string | null | undefined; tz: string | null; warning: RegExp | null }> = [
  { name: 'IANA name', timezone: 'America/New_York', tz: 'America/New_York', warning: null },
  { name: 'UTC', timezone: 'UTC', tz: 'UTC', warning: null },
  { name: 'wrong case is canonicalised', timezone: 'europe/paris', tz: PARIS, warning: null },
  { name: 'surrounding spaces', timezone: '  Asia/Tokyo ', tz: 'Asia/Tokyo', warning: null },
  { name: 'absent', timezone: undefined, tz: null, warning: /No time zone in the source/ },
  { name: 'null', timezone: null, tz: null, warning: /No time zone in the source/ },
  { name: 'empty', timezone: '', tz: null, warning: /No time zone in the source/ },
  { name: 'unknown name', timezone: 'Mars/Olympus', tz: null, warning: /Unknown time zone "Mars\/Olympus"/ },
  { name: 'fixed offset', timezone: '+02:00', tz: null, warning: /Unknown time zone/ },
  { name: 'path-like', timezone: '../etc/passwd', tz: null, warning: /Unknown time zone/ },
];

for (const { name, timezone, tz, warning } of zones) {
  test(`schedule-map: time zone — ${name}`, () => {
    const result = mapped(mapSchedule({ schedule: { kind: 'daily', time: '08:00' }, timezone, enabledInSource: true }));
    assert.equal(result.tz, tz);
    if (warning === null) assert.deepEqual(result.warnings, []);
    else {
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0] ?? '', warning);
    }
    assertDaemonAccepts(result.cron, result.tz, 'trigger');
  });
}

test('schedule-map: a missing zone is not worth a warning when every hour of every day runs alike', () => {
  for (const schedule of [{ kind: 'interval', minutes: 15 }, { kind: 'hourly', minute: 5 }] as const) {
    const result = mapped(mapSchedule({ schedule, enabledInSource: false }));
    assert.equal(result.tz, null);
    assert.deepEqual(result.warnings, []);
  }
  const restricted = mapped(mapSchedule({ schedule: { kind: 'cron', expression: '*/15 * * * 1-5' }, enabledInSource: false }));
  assert.equal(restricted.warnings.length, 1);
});

test('schedule-map: the routine fallback has no time zone and says so when one is dropped', () => {
  const dropped = mapped(mapSchedule({ schedule: { kind: 'daily', time: '08:00' }, timezone: PARIS, enabledInSource: true }, 'routine'));
  assert.equal(dropped.tz, null);
  assert.match(dropped.warnings[0] ?? '', /Time zone "Europe\/Paris" dropped/);
  const hourly = mapped(mapSchedule({ schedule: { kind: 'hourly' }, timezone: PARIS, enabledInSource: true }, 'routine'));
  assert.deepEqual(hourly.warnings, []);
});

test('schedule-map: canonicalTimeZone refuses what is not an IANA name', () => {
  assert.equal(canonicalTimeZone('Europe/Paris'), PARIS);
  assert.equal(canonicalTimeZone('Etc/GMT+5'), 'Etc/GMT+5');
  for (const bad of ['', ' ', 'GMT+02:00', 'Europe/Paris; rm', 'x'.repeat(65), 'Europe//Paris']) {
    assert.equal(canonicalTimeZone(bad), null, bad);
  }
});
