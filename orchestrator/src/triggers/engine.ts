/**
 * The trigger pipeline, the same for every source:
 *
 *   replay guard → filter → coalescing → actions → journal
 *
 * Authentication and body limits belong to the source (the webhook route);
 * once a call reaches `fireTrigger` it is genuine, but its content is still
 * untrusted.
 */
import { CronExpressionParser } from 'cron-parser';
import { evaluateFilter } from './filter.js';
import { lookup, type TriggerInput } from './payload.js';
import { runActions, type ActionOutcome } from './actions.js';
import {
  claimDelivery, claimScheduleRun, excerptOf, getTrigger, listDueSchedules, listTriggerRows, markTriggered,
  parseTrigger, recordDelivery, releaseDelivery, setNextRun, type Trigger,
} from './store.js';
import type { ScheduleConfig } from './schema.js';

export type FireResult =
  | { status: 'received'; outcomes: ActionOutcome[] }
  | { status: 'error'; outcomes: ActionOutcome[] }
  | { status: 'ignored'; reason: 'filter' }
  | { status: 'duplicate' }
  | { status: 'coalesced' };

/**
 * `replayKey` comes from the authenticated proof, `deliveryKey` from the id
 * the sender declares (signature.ts). Either one already seen = duplicate.
 */
type FireOptions = { replayKey?: string | null; deliveryKey?: string | null; excerpt?: string | null };

function guardKeys(opts: FireOptions): string[] {
  return [opts.replayKey, opts.deliveryKey].filter((k): k is string => !!k);
}

/** What the journal shows: the sender's id when there is one. */
function journalKey(opts: FireOptions): string | null {
  return opts.deliveryKey ?? opts.replayKey ?? null;
}

function execute(trigger: Trigger, input: TriggerInput, opts: FireOptions, reason: string | null = null): FireResult {
  if (trigger.source !== 'schedule') markTriggered(trigger.id, Date.now());
  const outcomes = runActions(trigger, input);
  const failed = outcomes.filter((o): o is Extract<ActionOutcome, { ok: false }> => !o.ok);
  // Nothing happened: the sender's retry must not be taken for a duplicate.
  // A partial failure keeps the claim — a retry would repeat what succeeded.
  if (failed.length === outcomes.length && guardKeys(opts).length) releaseDelivery(trigger.id, guardKeys(opts));
  const status = failed.length ? 'error' : 'received';
  recordDelivery({
    triggerId: trigger.id, status, deliveryKey: journalKey(opts), excerpt: opts.excerpt,
    reason: failed.length ? failed.map((f) => `${f.type}: ${f.error}`).join('; ') : reason,
    result: outcomes,
  });
  return { status, outcomes };
}

// ── coalescing ───────────────────────────────────────────────────────────────

type Pending = { triggerId: string; input: TriggerInput; firstAt: number; count: number; timer: NodeJS.Timeout; excerpt: string | null };
const pending = new Map<string, Pending>();
/** Beyond this many open bursts, events run at once rather than pile up in memory. */
const MAX_PENDING = 1000;

function flush(mapKey: string): void {
  const entry = pending.get(mapKey);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(mapKey);
  // Re-read: the trigger may have been disabled or deleted during the burst.
  const trigger = getTrigger(entry.triggerId);
  if (!trigger || !trigger.enabled) return;
  try {
    execute(trigger, entry.input, { excerpt: entry.excerpt }, `coalesced ${entry.count} call(s)`);
  } catch (err) {
    console.error(`[triggers] coalesced run of ${entry.triggerId} failed:`, (err as Error).message);
  }
}

/** True when the call joined (or opened) a burst; false = run it now. */
function coalesce(trigger: Trigger, input: TriggerInput, excerpt: string | null): boolean {
  if (trigger.source === 'schedule' || !trigger.config.coalesce) return false;
  const cfg = trigger.config.coalesce;
  const value = lookup(input, cfg.key);
  if (value === undefined || value === null) return false;
  const mapKey = `${trigger.id}\u0000${typeof value === 'string' ? value : JSON.stringify(value)}`;
  const now = Date.now();
  const existing = pending.get(mapKey);
  if (!existing && pending.size >= MAX_PENDING) return false;
  if (existing) {
    clearTimeout(existing.timer);
    existing.input = input;
    existing.excerpt = excerpt;
    existing.count += 1;
    if (cfg.max_ms !== undefined && now - existing.firstAt >= cfg.max_ms) {
      flush(mapKey);
      return true;
    }
  }
  const entry: Pending = existing ?? { triggerId: trigger.id, input, firstAt: now, count: 1, timer: undefined as unknown as NodeJS.Timeout, excerpt };
  entry.timer = setTimeout(() => flush(mapKey), cfg.quiet_ms);
  entry.timer.unref();
  pending.set(mapKey, entry);
  return true;
}

/** Plugin dispose: open bursts are dropped, and the journal says so. */
export function stopCoalescing(): void {
  for (const [key, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(key);
    recordDelivery({ triggerId: entry.triggerId, status: 'error', reason: `burst of ${entry.count} call(s) dropped at shutdown`, excerpt: entry.excerpt });
  }
}

/** Tests: run every open burst now. */
export function flushAllCoalesced(): void {
  for (const key of [...pending.keys()]) flush(key);
}

// ── pipeline ─────────────────────────────────────────────────────────────────

export function fireTrigger(trigger: Trigger, input: TriggerInput, opts: FireOptions = {}): FireResult {
  const excerpt = opts.excerpt ?? excerptOf(input.body);
  const keys = guardKeys(opts);
  if (keys.length && !claimDelivery(trigger.id, keys)) {
    recordDelivery({ triggerId: trigger.id, status: 'duplicate', deliveryKey: journalKey(opts), excerpt });
    return { status: 'duplicate' };
  }
  if (trigger.source !== 'schedule' && !evaluateFilter(trigger.filter, input)) {
    recordDelivery({ triggerId: trigger.id, status: 'ignored', reason: 'filter', deliveryKey: journalKey(opts), excerpt });
    return { status: 'ignored', reason: 'filter' };
  }
  if (coalesce(trigger, input, excerpt)) {
    recordDelivery({ triggerId: trigger.id, status: 'coalesced', deliveryKey: journalKey(opts), excerpt });
    return { status: 'coalesced' };
  }
  return execute(trigger, input, { ...opts, excerpt });
}

// ── schedule source ──────────────────────────────────────────────────────────

export function nextScheduleAt(config: ScheduleConfig, from: number): number {
  return CronExpressionParser.parse(config.cron, { currentDate: new Date(from), tz: config.tz }).next().getTime();
}

/** A schedule has no payload: its template variables are the run's time. */
export function scheduleInput(trigger: Trigger, now: number): TriggerInput {
  return { body: { now: new Date(now).toISOString(), timestamp: now, trigger: { id: trigger.id, name: trigger.name } }, headers: {} };
}

/**
 * Native schedule triggers due now. Like the routines: the next run is
 * computed from now (a daemon that was down does not catch up in bursts), and
 * claimed before running so two ticks never run the same occurrence.
 */
export function tickSchedules(now: number = Date.now()): void {
  for (const trigger of listDueSchedules(now)) {
    if (trigger.source !== 'schedule') continue;
    let next: number;
    try { next = nextScheduleAt(trigger.config, now); } catch { next = now + 60_000; }
    if (!claimScheduleRun(trigger.id, now, next)) continue;
    try {
      fireTrigger(trigger, scheduleInput(trigger, now));
    } catch (err) {
      recordDelivery({ triggerId: trigger.id, status: 'error', reason: (err as Error).message });
    }
  }
}

/** Boot: native schedules saved without a next run get one. */
export function armSchedules(now: number = Date.now()): void {
  for (const row of listTriggerRows({ source: 'schedule' })) {
    if (row.created_by === 'routine' || row.enabled !== 1 || row.next_run_at !== null) continue;
    const trigger = parseTrigger(row);
    if (trigger?.source !== 'schedule') continue;
    try { setNextRun(trigger.id, nextScheduleAt(trigger.config, now)); } catch (err) {
      console.warn(`[triggers] invalid cron for ${trigger.id}: ${(err as Error).message}`);
    }
  }
}
