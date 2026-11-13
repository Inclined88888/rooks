/**
 * Push relayed from the other machines of the fleet (multi-machine P4a,
 * TODO #329).
 *
 * A browser subscribes to Web Push with ONE daemon's VAPID key: the daemon
 * that serves the interface. A notification raised on another machine of the
 * fleet would therefore never reach the phone. So THIS daemon listens, for
 * every machine of every fleet it keeps, to that machine's event stream
 * (`/api/stream`, with the device token), and raises each new notification
 * here, in its owner's centre: the existing chain (`createNotification` →
 * centre + `web-push`) does the rest. The copy is marked:
 *
 *   source  `machine:<machine id>`              where it comes from
 *   anchor  `machine:<machine id>:<remote id>`  the one copy of one remote card
 *
 * Rules held here:
 *  - a card that already came from a machine (`source` = `machine:…`) is never
 *    relayed again: two daemons that pair with each other must not bounce a
 *    card back and forth forever;
 *  - on the remote, only the cards of the device's own account (and the
 *    unowned ones, the daemon's) are relayed — a superadmin device would
 *    otherwise copy every account's cards into one person's centre;
 *  - what the remote sends is validated and capped (size, rate): a remote
 *    machine is not trusted to flood this daemon or the phone;
 *  - a lost link reconnects with an exponential backoff; a 401 (device revoked
 *    or expired on the remote) stops the link and marks the machine
 *    `unauthorized` until it is paired again; removing the machine stops it.
 *    Closing the stream on revocation is the remote's job
 *    (`users/device-connections.ts`), which is why a revocation is seen at once.
 *
 * Limit, accepted by the user (24/10/2026): no relayed push while this daemon is off.
 */
import { z } from 'zod';
import { db, type NotificationRow } from '../db.js';
import { createNotification, dismissNotificationRow } from '../notifications.js';
import { MachineRequestError, machineRequest, type MachineResolver } from './client.js';
import { listRelayedMachines, machineToken, recordMachineStatus, type MachineRow } from './store.js';
import { openMachineStream, type MachineStreamEnd } from './stream.js';
import { RELAY_SOURCE_PREFIX, relayedAnchor, relayedSource } from './relayed.js';

/** How often the relay re-reads the fleet, on top of the explicit pokes. */
export const RELAY_RECONCILE_MS = 30_000;
/** Cards raised while the link was down, caught up at reconnection. Older ones are history. */
export const RELAY_CATCH_UP_MS = 60 * 60 * 1000;
/** Cards relayed per machine per minute; past it they wait for the next window. */
export const RELAY_MAX_PER_MINUTE = 30;
const RELAY_RATE_WINDOW_MS = 60_000;
/** A resync fires this long after the window frees a slot, so the slot is surely free. */
const RESYNC_MARGIN_MS = 50;
const RELAY_LIST_LIMIT = 50;
const TITLE_MAX = 200;
const BODY_MAX = 4_000;

export type RelayTimings = {
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** A link that stayed open this long resets its backoff. */
  stableMs: number;
  idleMs?: number;
};

const DEFAULT_TIMINGS: RelayTimings = { backoffBaseMs: 2_000, backoffMaxMs: 5 * 60_000, stableMs: 60_000 };

export type PushRelayOptions = {
  timings?: Partial<RelayTimings>;
  reconcileMs?: number;
  /** Test seam, as in `machineRequest`. */
  resolver?: MachineResolver;
  now?: () => number;
  /** Test seam: the window `RELAY_MAX_PER_MINUTE` is counted over. */
  rateWindowMs?: number;
};

const meAnswerSchema = z.object({ user: z.object({ id: z.string().min(1).max(128) }).passthrough() }).passthrough();

const remoteNotificationSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(['action_required', 'alert', 'report']),
  urgent: z.union([z.number(), z.boolean()]),
  title: z.string().max(10_000),
  body: z.string().max(200_000).nullable().optional(),
  mission_id: z.string().max(128).nullable().optional(),
  anchor: z.string().max(4_096).nullable().optional(),
  source: z.string().max(512).nullable().optional(),
  created_at: z.number().int().nonnegative(),
  dismissed_at: z.number().nullable().optional(),
  expires_at: z.number().int().nullable().optional(),
  owner_user_id: z.string().max(128).nullable().optional(),
}).passthrough();
type RemoteNotification = z.infer<typeof remoteNotificationSchema>;

const pendingAnswerSchema = z.object({
  pending: z.array(z.object({ id: z.string(), tool_name: z.string() }).passthrough()).max(500),
}).passthrough();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function localCopy(anchor: string, source: string): Pick<NotificationRow, 'id' | 'dismissed_at'> | undefined {
  return db.prepare(`SELECT id, dismissed_at FROM notifications WHERE anchor = ? AND source = ? LIMIT 1`)
    .get(anchor, source) as Pick<NotificationRow, 'id' | 'dismissed_at'> | undefined;
}

function localRow(id: string): NotificationRow | undefined {
  return db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id) as NotificationRow | undefined;
}

type LinkState = 'connecting' | 'open' | 'waiting' | 'dead' | 'stopped';

/** One machine's stream, and the cards it relays. */
class MachineLink {
  state: LinkState = 'waiting';
  name: string;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stream: { close: () => void } | null = null;
  private remoteUserId: string | null = null;
  private syncing = false;
  private dirty = false;
  private relayedAt: number[] = [];
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly startedAt: number;

  constructor(
    readonly machine: Pick<MachineRow, 'id' | 'owner_user_id' | 'url' | 'token_enc' | 'remote_device_id' | 'created_at'>,
    name: string,
    private readonly opts: { timings: RelayTimings; resolver?: MachineResolver; now: () => number; rateWindowMs: number },
  ) {
    this.name = name;
    this.startedAt = opts.now();
  }

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.state = 'stopped';
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
    this.stream?.close();
    this.stream = null;
  }

  private token(): string | null {
    try {
      return machineToken(this.machine);
    } catch {
      return null;
    }
  }

  /** The device is dead on the remote: nothing to retry until it is paired again. */
  private dead(): void {
    if (this.state === 'stopped') return;
    this.state = 'dead';
    this.stream?.close();
    this.stream = null;
    recordMachineStatus(this.machine.id, { status: 'unauthorized' }, this.opts.now());
    console.log(`[machines] push relay of ${this.machine.id.slice(0, 8)} stopped: the device is no longer accepted there`);
  }

  private retry(): void {
    if (this.state === 'stopped' || this.state === 'dead') return;
    this.state = 'waiting';
    const { backoffBaseMs, backoffMaxMs } = this.opts.timings;
    const ceiling = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.min(this.attempt, 20));
    // ±20 %: a daemon that restarts must not see its whole fleet reconnect in step.
    const delay = Math.round(ceiling * (0.8 + Math.random() * 0.4));
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'dead') return;
    this.state = 'connecting';
    const token = this.token();
    if (!token) {
      this.retry();
      return;
    }
    try {
      const me = await machineRequest(this.machine.url, { method: 'GET', path: '/api/auth/me', token, resolver: this.opts.resolver });
      if (this.state !== 'connecting') return;
      if (me.status === 401) {
        this.dead();
        return;
      }
      const parsed = meAnswerSchema.safeParse(me.json);
      if (me.status !== 200 || !parsed.success) {
        this.retry();
        return;
      }
      this.remoteUserId = parsed.data.user.id;
    } catch {
      if (this.state === 'connecting') this.retry();
      return;
    }
    let openedAt: number | null = null;
    // Named after the device: a reconnect replaces the stale stream on the
    // remote, and another daemon holding a device of the same account keeps its own.
    const path = `/api/stream?topics=notifications&client=relay-${encodeURIComponent(this.machine.remote_device_id).slice(0, 48)}`;
    this.stream = openMachineStream(this.machine.url, { path, token, idleMs: this.opts.timings.idleMs, resolver: this.opts.resolver }, {
      onOpen: () => {
        openedAt = this.opts.now();
        this.state = 'open';
        this.requestSync();
      },
      onEvent: (name) => {
        if (name === 'notifications_changed') this.requestSync();
      },
      onEnd: (end: MachineStreamEnd) => {
        this.stream = null;
        if (this.state === 'stopped' || end.kind === 'closed') return;
        if (end.kind === 'refused' && end.status === 401) {
          this.dead();
          return;
        }
        if (openedAt !== null && this.opts.now() - openedAt >= this.opts.timings.stableMs) this.attempt = 0;
        this.retry();
      },
    });
  }

  /** Coalesced: one sync at a time, and one more if something changed meanwhile. */
  requestSync(): void {
    if (this.syncing) {
      this.dirty = true;
      return;
    }
    this.syncing = true;
    void this.sync().finally(() => {
      this.syncing = false;
      if (this.dirty && this.state === 'open') {
        this.dirty = false;
        this.requestSync();
      }
    });
  }

  private underRate(now: number): boolean {
    this.relayedAt = this.relayedAt.filter((at) => now - at < this.opts.rateWindowMs);
    return this.relayedAt.length < RELAY_MAX_PER_MINUTE;
  }

  /**
   * The cards held back by the cap must not wait for the next
   * `notifications_changed`: on a quiet machine it may come after they left the
   * catch-up window, and they would never be relayed. One sync is therefore
   * due when the oldest relayed card leaves the window.
   */
  private scheduleResync(now: number): void {
    if (this.resyncTimer) return;
    const oldest = this.relayedAt[0] ?? now;
    const delay = Math.max(0, oldest + this.opts.rateWindowMs - now) + RESYNC_MARGIN_MS;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      if (this.state === 'open') this.requestSync();
    }, delay);
    this.resyncTimer.unref?.();
  }

  /** Remote permission id behind a yes/no card, for the push's inline buttons. */
  private async permissionId(token: string, card: RemoteNotification): Promise<string | null> {
    if (card.type !== 'action_required' || !card.anchor || !card.mission_id || !UUID.test(card.anchor)) return null;
    try {
      const answer = await machineRequest(this.machine.url, {
        method: 'GET', path: `/api/permissions?mission_id=${encodeURIComponent(card.mission_id)}`, token, resolver: this.opts.resolver,
      });
      const parsed = pendingAnswerSchema.safeParse(answer.json);
      if (answer.status !== 200 || !parsed.success) return null;
      // A question card awaits a form: two buttons would answer the wrong thing.
      const pending = parsed.data.pending.find((p) => p.id === card.anchor);
      return pending && pending.tool_name !== 'ask_user' ? card.anchor : null;
    } catch {
      return null;
    }
  }

  private async sync(): Promise<void> {
    const token = this.token();
    if (!token || this.state !== 'open') return;
    let rows: unknown[];
    try {
      const answer = await machineRequest(this.machine.url, {
        method: 'GET', path: `/api/notifications?archived=true&limit=${RELAY_LIST_LIMIT}`, token, resolver: this.opts.resolver,
      });
      if (answer.status === 401) {
        this.dead();
        return;
      }
      const list = (answer.json as { notifications?: unknown } | null)?.notifications;
      if (answer.status !== 200 || !Array.isArray(list)) return;
      rows = list.slice(0, RELAY_LIST_LIMIT);
    } catch (err) {
      if (!(err instanceof MachineRequestError)) throw err;
      return;
    }
    const cards = rows
      .map((row) => remoteNotificationSchema.safeParse(row))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
      .sort((a, b) => a.created_at - b.created_at);
    const source = relayedSource(this.machine.id);
    const since = Math.max(this.machine.created_at, this.startedAt - RELAY_CATCH_UP_MS);
    for (const card of cards) {
      if (this.state !== 'open') return;
      if (card.source?.startsWith(RELAY_SOURCE_PREFIX)) continue;
      const owner = card.owner_user_id ?? null;
      if (owner !== null && owner !== this.remoteUserId) continue;
      const anchor = relayedAnchor(this.machine.id, card.id);
      const copy = localCopy(anchor, source);
      if (card.dismissed_at != null) {
        // Dealt with over there: the copy here (and on the phone) goes too.
        if (copy && copy.dismissed_at === null) {
          const row = localRow(copy.id);
          if (row) dismissNotificationRow(row);
        }
        continue;
      }
      if (copy || card.created_at < since) continue;
      const now = this.opts.now();
      if (!this.underRate(now)) {
        console.warn(`[machines] push relay of ${this.machine.id.slice(0, 8)}: more than ${RELAY_MAX_PER_MINUTE} cards a minute, the rest waits`);
        this.scheduleResync(now);
        return;
      }
      const pushPermissionId = await this.permissionId(token, card);
      if (this.state !== 'open' || localCopy(anchor, source)) continue;
      const created = createNotification({
        type: card.type,
        urgent: card.urgent === true || card.urgent === 1,
        title: clip(`${this.name} · ${card.title}`, TITLE_MAX),
        body: card.body ? clip(card.body, BODY_MAX) : null,
        anchor,
        source,
        ownerUserId: this.machine.owner_user_id,
        expiresAt: card.expires_at ?? null,
        pushPermissionId,
      });
      if (created) this.relayedAt.push(now);
    }
  }
}

/** Every machine of every fleet, one link each. */
export class MachinePushRelay {
  private readonly links = new Map<string, MachineLink>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly timings: RelayTimings;
  private readonly now: () => number;

  constructor(private readonly opts: PushRelayOptions = {}) {
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), this.opts.reconcileMs ?? RELAY_RECONCILE_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const link of this.links.values()) link.stop();
    this.links.clear();
  }

  /** Aligns the links on the fleet: new machines start, removed ones stop, re-paired ones restart. */
  reconcile(): void {
    let rows: MachineRow[];
    try {
      rows = listRelayedMachines();
    } catch (err) {
      console.warn(`[machines] push relay cannot read the fleet: ${(err as Error).message}`);
      return;
    }
    const present = new Set<string>();
    for (const row of rows) {
      present.add(row.id);
      const link = this.links.get(row.id);
      // A new token (paired again) or a new owner is a new link; a rename is not.
      if (link && link.machine.token_enc === row.token_enc && link.machine.url === row.url && link.machine.owner_user_id === row.owner_user_id) {
        link.name = row.name;
        continue;
      }
      link?.stop();
      const next = new MachineLink(row, row.name, {
        timings: this.timings, resolver: this.opts.resolver, now: this.now, rateWindowMs: this.opts.rateWindowMs ?? RELAY_RATE_WINDOW_MS,
      });
      this.links.set(row.id, next);
      next.start();
    }
    for (const [id, link] of this.links) {
      if (present.has(id)) continue;
      link.stop();
      this.links.delete(id);
    }
  }

  /** What each link is doing, for the tests and the diagnostics. */
  states(): Record<string, LinkState> {
    return Object.fromEntries([...this.links].map(([id, link]) => [id, link.state]));
  }
}

let running: MachinePushRelay | null = null;

/** Started by the `@rooks/machines` module; the returned function stops it. */
export function startMachinePushRelay(opts: PushRelayOptions = {}): () => void {
  running?.stop();
  const relay = new MachinePushRelay(opts);
  running = relay;
  relay.start();
  return () => {
    relay.stop();
    if (running === relay) running = null;
  };
}

/** The fleet changed (paired, renamed, removed): align at once rather than at the next tick. */
export function fleetChanged(): void {
  running?.reconcile();
}
