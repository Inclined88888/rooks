/**
 * Device pairing (multi-machine P2a, TODO #329).
 *
 * A device is another Timon (its local daemon, its app) that a person paired
 * with THIS daemon to drive it remotely. It authenticates with its own
 * Bearer token, `req.auth.kind = 'device'`, and acts with every right of the
 * account that paired it, superadmin included (the maintainer's arbitration, 24/10/2026).
 *
 * It is core, not part of the Machines plugin: the daemon being reached must
 * accept a device without that plugin being enabled on it.
 *
 * Rules held by this file:
 *  - only hashes are stored: a stolen row is neither a code nor a token;
 *  - a pairing code is single-use, short-lived and burnt after a few wrong
 *    guesses; an unknown, expired, used or burnt code gets the same answer;
 *  - a device token is never the daemon-token, never an `api_tokens` row
 *    (distinct prefix, distinct table, distinct lookup), never read from a
 *    query string;
 *  - revocation is immediate: the row is read on every request, no cache;
 *  - a device dies after `DEVICE_IDLE_TTL_MS` without use, or with its owner.
 *
 * ── Stable `redeem` contract (V6: the local daemon calls it) ─────────────────
 *
 *   POST /api/devices/redeem            (public, HTTPS or loopback only)
 *   Content-Type: application/json
 *   { "code": "ABCD-EFGH-JKMN", "name": "Laptop" }
 *
 *   200 → DeviceRedeemResponse
 *   { "device": { "id", "name", "created_at" },
 *     "token": "tdev_…",                 // returned ONCE, store it sealed
 *     "user": { "id", "email", "name", "is_superadmin" },
 *     "idle_ttl_ms": 7776000000 }
 *   400 { "error": "invalid_request" }    body does not match the schema
 *   401 { "error": "invalid_code" }       unknown, expired, used or burnt
 *   403 { "error": "device_requires_tls" } plain HTTP from off the loopback
 *   429 { "error": "too many attempts, try again later" } + Retry-After
 *
 * The code is case-insensitive; dashes and spaces are ignored, and the
 * Crockford look-alikes (O→0, I/L→1) are folded. Then every request carries
 * `Authorization: Bearer <token>`.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db, dbApi, type UserRow } from '../db.js';
import { closeDeviceConnections, trackedDeviceIds } from './device-connections.js';
import { freeAccountAllowed } from './free-access.js';

export const DEVICE_TOKEN_PREFIX = 'tdev_';
/** Sliding: every use pushes the death of the token this far away. */
export const DEVICE_IDLE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
export const PAIRING_CODE_MAX_ATTEMPTS = 5;
/** Live codes one account may hold at once: pairing is a gesture, not a batch. */
export const PAIRING_CODES_PER_USER = 5;
/**
 * `last_seen_at` is written at most this often per device: one write per
 * request would turn every relayed call into a disk write.
 */
export const DEVICE_TOUCH_INTERVAL_MS = 60 * 1000;
/** A device idle this long that comes back is audited as a fresh use. */
export const DEVICE_USE_AUDIT_GAP_MS = 60 * 60 * 1000;
export const DEVICE_NAME_MAX = 64;

/** Crockford base32: no I, L, O, U — nothing to misread on a screen. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The selector finds the row, the rest is what the guess is about. */
const SELECTOR_LENGTH = 4;
const CODE_LENGTH = 12;

const deviceName = z.string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(DEVICE_NAME_MAX).regex(/^[^\p{Cc}]+$/u));

export const deviceRedeemRequestSchema = z.object({
  code: z.string().min(1).max(64),
  name: deviceName,
}).strict();
export type DeviceRedeemRequest = z.input<typeof deviceRedeemRequestSchema>;

export const deviceRenameSchema = z.object({ name: deviceName }).strict();

export const pairingCodeRequestSchema = z.object({
  /** Superadmin only: issue the code for another account. */
  user_id: z.string().min(1).max(128).optional(),
}).strict();

export type DeviceRedeemResponse = {
  device: { id: string; name: string; created_at: number };
  token: string;
  user: { id: string; email: string; name: string; is_superadmin: boolean };
  idle_ttl_ms: number;
};

export type DeviceRow = {
  id: string;
  token_hash: string;
  user_id: string;
  name: string;
  created_at: number;
  last_seen_at: number;
  last_ip: string | null;
  user_agent: string | null;
  revoked_at: number | null;
};

/** What a listing shows: never the hash. */
export type PublicDevice = {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
  last_seen_at: number;
  /** Address of the caller as this daemon saw it: the relay, not the browser. */
  last_ip: string | null;
  user_agent: string | null;
  revoked_at: number | null;
  expires_at: number;
  status: 'active' | 'revoked' | 'expired';
};

let schemaReady = false;

/**
 * The tables live here rather than in `db.ts`: the feature owns its schema.
 * Idempotent, run before the first statement of the process.
 */
export function ensureDeviceSchema(): void {
  if (schemaReady) return;
  db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_ip TEXT,
  user_agent TEXT,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS device_pairing_codes (
  selector TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_device_pairing_codes_user ON device_pairing_codes(user_id);
`);
  schemaReady = true;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isDeviceToken(token: string): boolean {
  return token.startsWith(DEVICE_TOKEN_PREFIX);
}

export function hashDeviceToken(token: string): string {
  return sha256(token);
}

/** Uppercase, separators dropped, look-alikes folded. `null` when not a code. */
export function normalizePairingCode(raw: string): string | null {
  const folded = raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (folded.length !== CODE_LENGTH) return null;
  for (const char of folded) if (!CROCKFORD.includes(char)) return null;
  return folded;
}

/** `XXXX-XXXX-XXXX`, the form shown to the person who types it. */
export function formatPairingCode(code: string): string {
  return code.match(/.{1,4}/g)!.join('-');
}

function randomCode(): string {
  // 256 is a multiple of 32: masking a byte keeps the draw unbiased.
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (const byte of bytes) out += CROCKFORD[byte & 31];
  return out;
}

export function deviceExpiresAt(device: Pick<DeviceRow, 'last_seen_at'>): number {
  return device.last_seen_at + DEVICE_IDLE_TTL_MS;
}

export function toPublicDevice(device: DeviceRow, now: number = Date.now()): PublicDevice {
  const expiresAt = deviceExpiresAt(device);
  return {
    id: device.id,
    user_id: device.user_id,
    name: device.name,
    created_at: device.created_at,
    last_seen_at: device.last_seen_at,
    last_ip: device.last_ip,
    user_agent: device.user_agent,
    revoked_at: device.revoked_at,
    expires_at: expiresAt,
    status: device.revoked_at !== null ? 'revoked' : expiresAt <= now ? 'expired' : 'active',
  };
}

export class PairingCodeLimitError extends Error {
  constructor() {
    super('too many pending pairing codes');
    this.name = 'PairingCodeLimitError';
  }
}

/** Returns the plaintext code ONCE; only its hash is kept. */
export function issuePairingCode(userId: string, now: number = Date.now()): { code: string; expiresAt: number } {
  ensureDeviceSchema();
  return db.transaction(() => {
    db.prepare(`DELETE FROM device_pairing_codes WHERE expires_at <= ? OR used_at IS NOT NULL OR attempts >= max_attempts`).run(now);
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM device_pairing_codes WHERE user_id = ?`).get(userId) as { n: number };
    if (pending.n >= PAIRING_CODES_PER_USER) throw new PairingCodeLimitError();
    for (;;) {
      const code = randomCode();
      const selector = code.slice(0, SELECTOR_LENGTH);
      // A selector clash is a 1-in-a-million event; draw again rather than
      // let two live codes share a row key.
      const clash = db.prepare(`SELECT 1 FROM device_pairing_codes WHERE selector = ?`).get(selector);
      if (clash) continue;
      const expiresAt = now + PAIRING_CODE_TTL_MS;
      db.prepare(
        `INSERT INTO device_pairing_codes (selector, code_hash, user_id, created_at, expires_at, attempts, max_attempts)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      ).run(selector, sha256(code), userId, now, expiresAt, PAIRING_CODE_MAX_ATTEMPTS);
      return { code, expiresAt };
    }
  })();
}

/**
 * - `ok`: the code was consumed, the device exists, `token` is its secret;
 * - `invalid`: nothing matched — same answer whatever the cause;
 * - `burnt`: a live code was just used up by wrong guesses (audited once).
 */
export type RedeemOutcome =
  | { kind: 'ok'; device: DeviceRow; token: string; user: UserRow }
  | { kind: 'invalid' }
  | { kind: 'burnt'; userId: string };

type CodeRow = {
  selector: string;
  code_hash: string;
  user_id: string;
  expires_at: number;
  attempts: number;
  max_attempts: number;
  used_at: number | null;
};

export function redeemPairingCode(input: {
  code: string;
  name: string;
  ip: string | null;
  userAgent: string | null;
  now?: number;
}): RedeemOutcome {
  ensureDeviceSchema();
  const now = input.now ?? Date.now();
  const code = normalizePairingCode(input.code);
  if (!code) return { kind: 'invalid' };
  return db.transaction((): RedeemOutcome => {
    const row = db.prepare(`SELECT * FROM device_pairing_codes WHERE selector = ?`)
      .get(code.slice(0, SELECTOR_LENGTH)) as CodeRow | undefined;
    if (!row || row.used_at !== null || row.expires_at <= now || row.attempts >= row.max_attempts) {
      return { kind: 'invalid' };
    }
    if (!hashesEqual(row.code_hash, sha256(code))) {
      const attempts = row.attempts + 1;
      db.prepare(`UPDATE device_pairing_codes SET attempts = ? WHERE selector = ?`).run(attempts, row.selector);
      return attempts >= row.max_attempts ? { kind: 'burnt', userId: row.user_id } : { kind: 'invalid' };
    }
    // Single use, enforced by the row rather than by our reading of it.
    const consumed = db.prepare(
      `UPDATE device_pairing_codes SET used_at = ? WHERE selector = ? AND used_at IS NULL`,
    ).run(now, row.selector);
    if (consumed.changes !== 1) return { kind: 'invalid' };
    const user = dbApi.getUserById(row.user_id);
    if (!user || user.status !== 'active') return { kind: 'invalid' };
    const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const device: DeviceRow = {
      id: randomUUID(),
      token_hash: hashDeviceToken(token),
      user_id: user.id,
      name: input.name,
      created_at: now,
      last_seen_at: now,
      last_ip: input.ip,
      user_agent: input.userAgent ? input.userAgent.slice(0, 512) : null,
      revoked_at: null,
    };
    db.prepare(
      `INSERT INTO devices (id, token_hash, user_id, name, created_at, last_seen_at, last_ip, user_agent, revoked_at)
       VALUES (@id, @token_hash, @user_id, @name, @created_at, @last_seen_at, @last_ip, @user_agent, NULL)`,
    ).run(device);
    return { kind: 'ok', device, token, user };
  })();
}

export type DeviceLookup =
  | { kind: 'live'; device: DeviceRow; user: UserRow }
  /** The token names a row that may no longer act: revoked, idle, owner gone. */
  | { kind: 'dead'; device: DeviceRow }
  | { kind: 'unknown' };

export function lookupDevice(token: string, now: number = Date.now()): DeviceLookup {
  ensureDeviceSchema();
  const device = db.prepare(`SELECT * FROM devices WHERE token_hash = ?`)
    .get(hashDeviceToken(token)) as DeviceRow | undefined;
  if (!device) return { kind: 'unknown' };
  if (device.revoked_at !== null || deviceExpiresAt(device) <= now) return { kind: 'dead', device };
  const user = dbApi.getUserById(device.user_id);
  if (!user || user.status !== 'active') return { kind: 'dead', device };
  return { kind: 'live', device, user };
}

/**
 * Slides the expiry. Returns true when the use deserves an audit row: first
 * use from a new address, or a return after a long silence.
 */
export function touchDevice(device: DeviceRow, ip: string | null, now: number = Date.now()): boolean {
  const idle = now - device.last_seen_at;
  const moved = ip !== null && ip !== device.last_ip;
  if (idle < DEVICE_TOUCH_INTERVAL_MS && !moved) return false;
  db.prepare(`UPDATE devices SET last_seen_at = ?, last_ip = COALESCE(?, last_ip) WHERE id = ?`)
    .run(now, ip, device.id);
  return moved || idle >= DEVICE_USE_AUDIT_GAP_MS;
}

export function getDevice(id: string): DeviceRow | undefined {
  ensureDeviceSchema();
  return db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id) as DeviceRow | undefined;
}

/** `userId` null = every device of the daemon (superadmin view). */
export function listDevices(userId: string | null): DeviceRow[] {
  ensureDeviceSchema();
  return userId === null
    ? db.prepare(`SELECT * FROM devices ORDER BY created_at DESC`).all() as DeviceRow[]
    : db.prepare(`SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as DeviceRow[];
}

export function renameDevice(id: string, name: string): DeviceRow | undefined {
  ensureDeviceSchema();
  db.prepare(`UPDATE devices SET name = ? WHERE id = ?`).run(name, id);
  return getDevice(id);
}

/**
 * Idempotent: a second revocation keeps the first date. The device's open
 * WebSockets and event streams close with it: a revoked device must not keep
 * a shell or a screen it opened before.
 */
export function revokeDevice(id: string, now: number = Date.now()): DeviceRow | undefined {
  ensureDeviceSchema();
  db.prepare(`UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now, id);
  closeDeviceConnections(id);
  return getDevice(id);
}

/**
 * Same verdict as `lookupDevice`, for a device known by its id — plus the Free
 * fallback, as `upgradeAuth` checks it: an account a lapsed licence no longer
 * admits loses the connections its devices hold open, not only its next request.
 */
export function deviceIsLive(id: string, now: number = Date.now()): boolean {
  const device = getDevice(id);
  if (!device || device.revoked_at !== null || deviceExpiresAt(device) <= now) return false;
  const user = dbApi.getUserById(device.user_id);
  return Boolean(user && user.status === 'active' && freeAccountAllowed(user.id));
}

/**
 * Closes the open connections of every device that died since they opened:
 * idle expiry, owner disabled or deleted, owner no longer admitted by Free.
 * Revocation does not wait for it.
 */
export function sweepDeviceConnections(now: number = Date.now()): number {
  let closed = 0;
  for (const id of trackedDeviceIds()) {
    if (!deviceIsLive(id, now)) closed += closeDeviceConnections(id);
  }
  return closed;
}
