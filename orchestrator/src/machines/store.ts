/**
 * The fleet of machines (multi-machine P2c, TODO #329): the other Rooks
 * daemons a person of THIS daemon has paired with, and the device token each
 * one gave back.
 *
 *  - One fleet per local account (`owner_user_id`): another account, even a
 *    superadmin, neither sees nor uses it — every read takes the owner.
 *  - The token is sealed with the vault's master key (`secrets/box.ts`), bound
 *    to its row (`machineTokenIdentity`), and rotates with the vault
 *    (`secrets/sealed-columns.ts`). It is opened only for the app's relay
 *    (`GET /api/machines/:id/credential`) and for this daemon's own calls.
 *  - The URL has passed `parseMachineUrl` before it is written here.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { machineTokenIdentity } from '../secrets/sealed-columns.js';
import { openWithVault, sealWithVault } from '../secrets/store.js';

export const MACHINE_NAME_MAX = 64;
/** A fleet is a handful of computers; a thousand rows is a script, not a person. */
export const MACHINES_PER_OWNER = 50;

/** What this daemon last saw of the machine. */
export type MachineStatus = 'unknown' | 'online' | 'unreachable' | 'unauthorized' | 'tls_error' | 'error';

export type MachineRow = {
  id: string;
  owner_user_id: string;
  name: string;
  url: string;
  token_enc: string;
  remote_device_id: string;
  remote_user_email: string | null;
  remote_user_name: string | null;
  remote_is_superadmin: number;
  status: MachineStatus;
  version: string | null;
  api_level: number | null;
  last_checked_at: number | null;
  last_ok_at: number | null;
  created_at: number;
  updated_at: number;
};

/** What a listing shows: never the token, sealed or not. */
export type PublicMachine = {
  id: string;
  name: string;
  url: string;
  status: MachineStatus;
  version: string | null;
  api_level: number | null;
  last_checked_at: number | null;
  last_ok_at: number | null;
  created_at: number;
  updated_at: number;
  /** The account this machine's device acts as, on that machine. */
  remote_user: { email: string | null; name: string | null; is_superadmin: boolean };
};

let schemaReady = false;

/** The feature owns its table; idempotent, run before the first statement. */
export function ensureMachineSchema(): void {
  if (schemaReady) return;
  db.exec(`
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  remote_device_id TEXT NOT NULL,
  remote_user_email TEXT,
  remote_user_name TEXT,
  remote_is_superadmin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown',
  version TEXT,
  api_level INTEGER,
  last_checked_at INTEGER,
  last_ok_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, url),
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_machines_owner ON machines(owner_user_id);
`);
  schemaReady = true;
}

export function toPublicMachine(row: MachineRow): PublicMachine {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    status: row.status,
    version: row.version,
    api_level: row.api_level,
    last_checked_at: row.last_checked_at,
    last_ok_at: row.last_ok_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    remote_user: { email: row.remote_user_email, name: row.remote_user_name, is_superadmin: row.remote_is_superadmin === 1 },
  };
}

export function listMachines(ownerUserId: string): MachineRow[] {
  ensureMachineSchema();
  return db.prepare(`SELECT * FROM machines WHERE owner_user_id = ? ORDER BY created_at ASC`).all(ownerUserId) as MachineRow[];
}

/**
 * Every machine of every fleet whose owner is still active: the push relay
 * keeps one stream per machine, whoever owns it. Server side only.
 */
export function listRelayedMachines(): MachineRow[] {
  ensureMachineSchema();
  return db.prepare(
    `SELECT m.* FROM machines m JOIN users u ON u.id = m.owner_user_id
      WHERE u.status = 'active' ORDER BY m.created_at ASC`,
  ).all() as MachineRow[];
}

/** `undefined` for an unknown id AND for another account's machine: one answer. */
export function getOwnedMachine(ownerUserId: string, id: string): MachineRow | undefined {
  ensureMachineSchema();
  return db.prepare(`SELECT * FROM machines WHERE id = ? AND owner_user_id = ?`).get(id, ownerUserId) as MachineRow | undefined;
}

export function findOwnedMachineByUrl(ownerUserId: string, url: string): MachineRow | undefined {
  ensureMachineSchema();
  return db.prepare(`SELECT * FROM machines WHERE owner_user_id = ? AND url = ?`).get(ownerUserId, url) as MachineRow | undefined;
}

export function countOwnedMachines(ownerUserId: string): number {
  ensureMachineSchema();
  return (db.prepare(`SELECT COUNT(*) AS n FROM machines WHERE owner_user_id = ?`).get(ownerUserId) as { n: number }).n;
}

export type PairedMachineInput = {
  ownerUserId: string;
  name: string;
  url: string;
  token: string;
  remoteDeviceId: string;
  remoteUser: { email: string; name: string; is_superadmin: boolean };
  now?: number;
};

/**
 * Writes a freshly paired machine. Pairing again a URL already in the fleet
 * replaces its token in place and keeps its id: the interface keys its local
 * state by that id (`machine-storage.ts`), and an expired or revoked device is
 * paired anew, not added twice. Returns the row and whether it was new.
 */
export function savePairedMachine(input: PairedMachineInput): { row: MachineRow; created: boolean; replacedDeviceId: string | null } {
  ensureMachineSchema();
  const now = input.now ?? Date.now();
  return db.transaction(() => {
    const existing = findOwnedMachineByUrl(input.ownerUserId, input.url);
    const id = existing?.id ?? randomUUID();
    const tokenEnc = sealWithVault(input.token, machineTokenIdentity(id));
    if (existing) {
      db.prepare(
        `UPDATE machines SET token_enc = ?, remote_device_id = ?, remote_user_email = ?, remote_user_name = ?,
           remote_is_superadmin = ?, status = 'unknown', updated_at = ? WHERE id = ?`,
      ).run(tokenEnc, input.remoteDeviceId, input.remoteUser.email, input.remoteUser.name,
        input.remoteUser.is_superadmin ? 1 : 0, now, id);
    } else {
      db.prepare(
        `INSERT INTO machines (id, owner_user_id, name, url, token_enc, remote_device_id, remote_user_email,
           remote_user_name, remote_is_superadmin, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
      ).run(id, input.ownerUserId, input.name, input.url, tokenEnc, input.remoteDeviceId, input.remoteUser.email,
        input.remoteUser.name, input.remoteUser.is_superadmin ? 1 : 0, now, now);
    }
    const row = getOwnedMachine(input.ownerUserId, id)!;
    return { row, created: !existing, replacedDeviceId: existing && existing.remote_device_id !== input.remoteDeviceId ? existing.remote_device_id : null };
  })();
}

/** The device token, opened. Server side only: never part of a listing. */
export function machineToken(row: Pick<MachineRow, 'id' | 'token_enc'>): string {
  return openWithVault(row.token_enc, machineTokenIdentity(row.id));
}

export function renameMachine(ownerUserId: string, id: string, name: string, now: number = Date.now()): MachineRow | undefined {
  ensureMachineSchema();
  db.prepare(`UPDATE machines SET name = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?`).run(name, now, id, ownerUserId);
  return getOwnedMachine(ownerUserId, id);
}

export function deleteMachine(ownerUserId: string, id: string): boolean {
  ensureMachineSchema();
  return db.prepare(`DELETE FROM machines WHERE id = ? AND owner_user_id = ?`).run(id, ownerUserId).changes === 1;
}

export function recordMachineStatus(
  id: string,
  seen: { status: MachineStatus; version?: string | null; apiLevel?: number | null },
  now: number = Date.now(),
): void {
  ensureMachineSchema();
  if (seen.status === 'online') {
    db.prepare(
      `UPDATE machines SET status = 'online', version = ?, api_level = ?, last_checked_at = ?, last_ok_at = ? WHERE id = ?`,
    ).run(seen.version ?? null, seen.apiLevel ?? null, now, now, id);
    return;
  }
  db.prepare(`UPDATE machines SET status = ?, last_checked_at = ? WHERE id = ?`).run(seen.status, now, id);
}
