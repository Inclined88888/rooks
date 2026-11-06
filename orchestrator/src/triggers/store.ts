/**
 * Persistence of native triggers: rows, the call journal and the replay guard.
 * Tables are created by `db.ts` (the routines view needs them before any
 * plugin loads); this file is the only one that writes them for triggers.
 *
 * Both secrets of a trigger are sealed with the vault envelope, bound to the
 * trigger's id (`secrets/sealed-columns.ts`, so a key rotation carries them):
 * a copy of the database, a backup included, holds no usable secret. The
 * typed `Trigger` carries them opened; a `TriggerRow` never does.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { triggerOutboundSecretIdentity, triggerSecretIdentity } from '../secrets/sealed-columns.js';
import { isSealed } from '../secrets/box.js';
import { openWithVault, sealWithVault } from '../secrets/store.js';
import type { Filter } from './filter.js';
import { filterSchema } from './filter.js';
import {
  actionSchema, eventConfigSchema, scheduleConfigSchema, webhookConfigSchema,
  type EventConfig, type ScheduleConfig, type TriggerAction, type TriggerSource, type WebhookConfig,
} from './schema.js';

export type TriggerRow = {
  id: string;
  name: string;
  slug: string | null;
  source: TriggerSource;
  enabled: number;
  config: string;
  filter: string | null;
  actions: string;
  /** Sealed envelope; open it with `parseTrigger`. */
  secret: string | null;
  /** Signs the calls of its `webhook` actions (`whsec_…`); never returned but once. Sealed like `secret`. */
  outbound_secret: string | null;
  owner_user_id: string | null;
  /** `user` (session or operator), `agent` (mission token), `routine` (legacy), `workflow` (façade of a workflow entry node). */
  created_by: 'user' | 'agent' | 'routine' | 'workflow';
  creator_agent: string | null;
  /**
   * The agent whose delegation list (`orchestrates`) bounds the task actions,
   * re-checked at every run: the last agent that saved the trigger, NULL once
   * a human saves it — flipping only its switch keeps it. Follows the last
   * editor, like `grants`.
   */
  acting_agent: string | null;
  /**
   * When a person last switched it on (TODO #572); NULL while off, or on
   * without anyone having looked (an agent's trigger made before #529).
   */
  approved_at: number | null;
  /** Frozen permissions, JSON array; NULL = system row (routines), unrestricted. */
  grants: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
};

type Common = {
  id: string;
  name: string;
  enabled: boolean;
  filter: Filter | null;
  actions: TriggerAction[];
  secret: string | null;
  outboundSecret: string | null;
  ownerUserId: string | null;
  createdBy: TriggerRow['created_by'];
  creatorAgent: string | null;
  actingAgent: string | null;
  grants: string[] | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type Trigger =
  | (Common & { source: 'schedule'; slug: null; config: ScheduleConfig })
  | (Common & { source: 'webhook'; slug: string; config: WebhookConfig })
  | (Common & { source: 'event'; slug: null; config: EventConfig });

/**
 * Stored row → typed trigger, re-validated. A row that no longer parses (hand
 * edit, older shape) is reported and skipped rather than half-executed.
 */
/**
 * A sealed column, opened. A vault that cannot open it (key lost, row copied
 * from another trigger) leaves the trigger without that secret — its webhook
 * answers 401, its outgoing calls wait — rather than unreadable as a whole:
 * its other sources and actions keep running. The vault's message names no value.
 */
function openColumn(value: string | null, triggerId: string, outbound: boolean): string | null {
  if (value === null) return null;
  try {
    return openWithVault(value, outbound ? triggerOutboundSecretIdentity(triggerId) : triggerSecretIdentity(triggerId));
  } catch (err) {
    console.warn(`[triggers] ${triggerId}: ${outbound ? 'outbound secret' : 'secret'} unreadable — ${(err as Error).message}`);
    return null;
  }
}

export function parseTrigger(row: TriggerRow): Trigger | null {
  try {
    const actions = (JSON.parse(row.actions) as unknown[]).map((a) => actionSchema.parse(a));
    const filter = row.filter ? filterSchema.parse(JSON.parse(row.filter)) : null;
    const grants = row.grants ? (JSON.parse(row.grants) as unknown[]).filter((g): g is string => typeof g === 'string') : null;
    const common: Common = {
      id: row.id, name: row.name, enabled: row.enabled === 1, filter, actions,
      secret: openColumn(row.secret, row.id, false), outboundSecret: openColumn(row.outbound_secret ?? null, row.id, true),
      ownerUserId: row.owner_user_id, createdBy: row.created_by, creatorAgent: row.creator_agent, actingAgent: row.acting_agent, grants,
      lastRunAt: row.last_run_at, nextRunAt: row.next_run_at, createdAt: row.created_at, updatedAt: row.updated_at,
    };
    const config: unknown = JSON.parse(row.config);
    if (row.source === 'schedule') return { ...common, source: 'schedule', slug: null, config: scheduleConfigSchema.parse(config) };
    if (row.source === 'webhook' && row.slug) return { ...common, source: 'webhook', slug: row.slug, config: webhookConfigSchema.parse(config) };
    if (row.source === 'event') return { ...common, source: 'event', slug: null, config: eventConfigSchema.parse(config) };
    throw new Error(`unknown source ${row.source}`);
  } catch (err) {
    console.warn(`[triggers] ${row.id} unreadable, skipped: ${(err as Error).message}`);
    return null;
  }
}

export function getTriggerRow(id: string): TriggerRow | undefined {
  return db.prepare(`SELECT * FROM triggers WHERE id = ?`).get(id) as TriggerRow | undefined;
}

export function getTrigger(id: string): Trigger | null {
  const row = getTriggerRow(id);
  return row ? parseTrigger(row) : null;
}

export function getWebhookTrigger(slug: string): Trigger | null {
  const row = db.prepare(`SELECT * FROM triggers WHERE slug = ? AND source = 'webhook'`).get(slug) as TriggerRow | undefined;
  return row ? parseTrigger(row) : null;
}

/** `ownerId` undefined = every row (superadmin view). */
export function listTriggerRows(opts: { source?: TriggerSource; ownerId?: string | null } = {}): TriggerRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.source) { where.push('source = ?'); args.push(opts.source); }
  if (opts.ownerId !== undefined) {
    if (opts.ownerId === null) where.push('owner_user_id IS NULL');
    else { where.push('owner_user_id = ?'); args.push(opts.ownerId); }
  }
  return db.prepare(`SELECT * FROM triggers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`)
    .all(...args) as TriggerRow[];
}

export function listEnabledTriggers(source: TriggerSource): Trigger[] {
  return (db.prepare(`SELECT * FROM triggers WHERE source = ? AND enabled = 1`).all(source) as TriggerRow[])
    .map(parseTrigger)
    .filter((t): t is Trigger => t !== null);
}

/** Native schedule triggers that are due. Routines tick on their own path. */
export function listDueSchedules(now: number): Trigger[] {
  return (db.prepare(
    `SELECT * FROM triggers WHERE source = 'schedule' AND created_by != 'routine'
       AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
  ).all(now) as TriggerRow[]).map(parseTrigger).filter((t): t is Trigger => t !== null);
}

export type NewTrigger = {
  name: string;
  slug: string | null;
  source: TriggerSource;
  enabled: boolean;
  config: unknown;
  filter: Filter | null;
  actions: TriggerAction[];
  secret: string | null;
  ownerUserId: string | null;
  createdBy: 'user' | 'agent' | 'workflow';
  creatorAgent: string | null;
  actingAgent: string | null;
  grants: string[];
  nextRunAt: number | null;
};

export function insertTrigger(t: NewTrigger): TriggerRow {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO triggers (id, name, slug, source, enabled, config, filter, actions, secret, owner_user_id,
       created_by, creator_agent, acting_agent, grants, last_run_at, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    id, t.name, t.slug, t.source, t.enabled ? 1 : 0, JSON.stringify(t.config),
    t.filter ? JSON.stringify(t.filter) : null, JSON.stringify(t.actions),
    t.secret === null ? null : sealWithVault(t.secret, triggerSecretIdentity(id)), t.ownerUserId,
    t.createdBy, t.creatorAgent, t.actingAgent, JSON.stringify(t.grants), t.nextRunAt, now, now,
  );
  return getTriggerRow(id)!;
}

export function updateTriggerRow(id: string, fields: {
  name: string; slug: string | null; enabled: boolean; config: unknown; filter: Filter | null;
  actions: TriggerAction[]; grants: string[] | null; actingAgent: string | null; nextRunAt: number | null;
  /** Absent: unchanged. */
  approvedAt?: number | null;
}): TriggerRow {
  db.prepare(
    `UPDATE triggers SET name = ?, slug = ?, enabled = ?, config = ?, filter = ?, actions = ?, grants = ?,
       acting_agent = ?, next_run_at = ?, approved_at = CASE WHEN ? = 1 THEN ? ELSE approved_at END,
       updated_at = ? WHERE id = ?`,
  ).run(
    fields.name, fields.slug, fields.enabled ? 1 : 0, JSON.stringify(fields.config),
    fields.filter ? JSON.stringify(fields.filter) : null, JSON.stringify(fields.actions),
    fields.grants === null ? null : JSON.stringify(fields.grants), fields.actingAgent, fields.nextRunAt,
    fields.approvedAt === undefined ? 0 : 1, fields.approvedAt ?? null, Date.now(), id,
  );
  return getTriggerRow(id)!;
}

/** Switches a trigger off and nothing else; a schedule also forgets its next run. */
export function disableTriggerRow(id: string): boolean {
  return db.prepare(`UPDATE triggers SET enabled = 0, next_run_at = NULL, approved_at = NULL, updated_at = ? WHERE id = ? AND enabled = 1`)
    .run(Date.now(), id).changes === 1;
}

export type UnapprovedTrigger = Pick<TriggerRow, 'id' | 'name' | 'source' | 'owner_user_id' | 'creator_agent'>;

/**
 * Switches off every agent's trigger that runs without a person having
 * switched it on (TODO #572): those made by a mission token before an agent's
 * trigger was born off (#529). Before #529 any human save cleared
 * `acting_agent`, so an agent row that still carries one was never saved by a
 * person; since #529 an agent cannot switch one on, and a person who does
 * stamps `approved_at`. Run at boot, before any source is armed; idempotent.
 * Returns what it switched off, for the owners to be told.
 */
export function disableUnapprovedAgentTriggers(): UnapprovedTrigger[] {
  const now = Date.now();
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT id, name, source, owner_user_id, creator_agent FROM triggers
         WHERE created_by = 'agent' AND acting_agent IS NOT NULL AND enabled = 1 AND approved_at IS NULL
         ORDER BY created_at`,
    ).all() as UnapprovedTrigger[];
    const off = db.prepare(`UPDATE triggers SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?`);
    for (const row of rows) off.run(now, row.id);
    return rows;
  })();
}

export function setTriggerSecret(id: string, secret: string): void {
  db.prepare(`UPDATE triggers SET secret = ?, updated_at = ? WHERE id = ?`)
    .run(sealWithVault(secret, triggerSecretIdentity(id)), Date.now(), id);
}

export function setTriggerOutboundSecret(id: string, secret: string): void {
  db.prepare(`UPDATE triggers SET outbound_secret = ?, updated_at = ? WHERE id = ?`)
    .run(sealWithVault(secret, triggerOutboundSecretIdentity(id)), Date.now(), id);
}

/**
 * Seals the secrets stored in the clear before triggers were sealed. Run at
 * boot by the plugin; idempotent, one transaction. `secure_delete` for the
 * duration, so the pages that held the clear values are zeroed rather than
 * left in the file. Returns how many values were sealed.
 */
export function sealLegacyTriggerSecrets(): number {
  const rows = db.prepare(`SELECT id, secret, outbound_secret FROM triggers WHERE secret IS NOT NULL OR outbound_secret IS NOT NULL`)
    .all() as Array<{ id: string; secret: string | null; outbound_secret: string | null }>;
  const pending = rows.filter((row) => (row.secret !== null && !isSealed(row.secret))
    || (row.outbound_secret !== null && !isSealed(row.outbound_secret)));
  if (pending.length === 0) return 0;
  const before = db.pragma('secure_delete', { simple: true }) as number;
  db.pragma('secure_delete = ON');
  try {
    let sealed = 0;
    db.transaction(() => {
      for (const row of pending) {
        if (row.secret !== null && !isSealed(row.secret)) {
          db.prepare(`UPDATE triggers SET secret = ? WHERE id = ?`).run(sealWithVault(row.secret, triggerSecretIdentity(row.id)), row.id);
          sealed += 1;
        }
        if (row.outbound_secret !== null && !isSealed(row.outbound_secret)) {
          db.prepare(`UPDATE triggers SET outbound_secret = ? WHERE id = ?`)
            .run(sealWithVault(row.outbound_secret, triggerOutboundSecretIdentity(row.id)), row.id);
          sealed += 1;
        }
      }
    })();
    return sealed;
  } finally {
    db.pragma(`secure_delete = ${before === 2 ? 'FAST' : before ? 'ON' : 'OFF'}`);
  }
}

export function deleteTrigger(id: string): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM triggers WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM trigger_deliveries WHERE trigger_id = ?`).run(id);
    db.prepare(`DELETE FROM trigger_dedupe WHERE trigger_id = ?`).run(id);
    db.prepare(`DELETE FROM trigger_outbox WHERE trigger_id = ? AND delivered_at IS NULL`).run(id);
  })();
}

/** Claims a schedule run: only the tick that moves `next_run_at` runs it. */
export function claimScheduleRun(id: string, now: number, next: number | null): boolean {
  return db.prepare(
    `UPDATE triggers SET last_run_at = ?, next_run_at = ? WHERE id = ? AND next_run_at IS NOT NULL AND next_run_at <= ?`,
  ).run(now, next, id, now).changes > 0;
}

export function setNextRun(id: string, next: number | null): void {
  db.prepare(`UPDATE triggers SET next_run_at = ? WHERE id = ?`).run(next, id);
}

export function markTriggered(id: string, at: number): void {
  db.prepare(`UPDATE triggers SET last_run_at = ? WHERE id = ?`).run(at, id);
}

export function setTaskTrigger(taskId: string, triggerId: string): void {
  db.prepare(`UPDATE tasks SET trigger_id = ? WHERE id = ?`).run(triggerId, taskId);
}

// ── journal ──────────────────────────────────────────────────────────────────

/**
 * Journal retention: the last calls of each trigger, not a time window — a
 * busy route and a monthly cron both keep something to look at.
 */
export const JOURNAL_KEEP = 200;
const EXCERPT_MAX = 2048;

export type DeliveryStatus = 'received' | 'ignored' | 'duplicate' | 'coalesced' | 'error' | 'rejected' | 'test';

export type DeliveryRow = {
  id: number;
  trigger_id: string;
  at: number;
  status: DeliveryStatus;
  reason: string | null;
  delivery_key: string | null;
  excerpt: string | null;
  result: string | null;
};

export function excerptOf(value: unknown): string | null {
  if (value === undefined) return null;
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''; } catch { return null; }
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}…` : text;
}

export function recordDelivery(entry: {
  triggerId: string; status: DeliveryStatus; reason?: string | null; deliveryKey?: string | null;
  excerpt?: string | null; result?: unknown;
}): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO trigger_deliveries (trigger_id, at, status, reason, delivery_key, excerpt, result) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.triggerId, Date.now(), entry.status, entry.reason ?? null, entry.deliveryKey ?? null,
      entry.excerpt ?? null, entry.result === undefined ? null : JSON.stringify(entry.result),
    );
    db.prepare(
      `DELETE FROM trigger_deliveries WHERE trigger_id = ? AND id NOT IN (
         SELECT id FROM trigger_deliveries WHERE trigger_id = ? ORDER BY id DESC LIMIT ?)`,
    ).run(entry.triggerId, entry.triggerId, JOURNAL_KEEP);
  })();
}

export function listDeliveries(triggerId: string, limit = 50): DeliveryRow[] {
  return db.prepare(`SELECT * FROM trigger_deliveries WHERE trigger_id = ? ORDER BY id DESC LIMIT ?`)
    .all(triggerId, Math.max(1, Math.min(limit, JOURNAL_KEEP))) as DeliveryRow[];
}

// ── replay guard ─────────────────────────────────────────────────────────────

/** Long enough to outlive any sender's retry policy (GitHub: days). */
export const DEDUPE_TTL_MS = 30 * 24 * 3600_000;
let lastDedupeSweep = 0;

/**
 * True when the delivery is new; false when ANY of its keys was already
 * claimed. All or nothing: a duplicate claims none of its keys, so a replay
 * carrying a fresh declared id cannot burn that id for the real sender.
 */
export function claimDelivery(triggerId: string, keys: readonly string[], now: number = Date.now()): boolean {
  if (now - lastDedupeSweep > 3600_000) {
    db.prepare(`DELETE FROM trigger_dedupe WHERE at < ?`).run(now - DEDUPE_TTL_MS);
    lastDedupeSweep = now;
  }
  const seen = db.prepare(`SELECT 1 FROM trigger_dedupe WHERE trigger_id = ? AND key = ?`);
  const insert = db.prepare(`INSERT INTO trigger_dedupe (trigger_id, key, at) VALUES (?, ?, ?)`);
  return db.transaction(() => {
    if (keys.some((key) => seen.get(triggerId, key) !== undefined)) return false;
    for (const key of new Set(keys)) insert.run(triggerId, key, now);
    return true;
  })();
}

/** A delivery whose actions all failed is released: the sender's retry must run. */
export function releaseDelivery(triggerId: string, keys: readonly string[]): void {
  const remove = db.prepare(`DELETE FROM trigger_dedupe WHERE trigger_id = ? AND key = ?`);
  db.transaction(() => { for (const key of keys) remove.run(triggerId, key); })();
}
