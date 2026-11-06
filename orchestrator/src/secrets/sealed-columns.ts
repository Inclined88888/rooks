/**
 * Columns, outside `secrets` and `plugin_kv`, that keep values sealed under
 * the vault's master key.
 *
 * A key rotation (`rekeyVault`) must reseal EVERY envelope in the same
 * transaction, and a rotation recovery needs a witness wherever envelopes
 * live: a column it does not know about is a column a rotation strands under a
 * key that no longer exists. Hence a static list read by `store.ts`, rather
 * than a registration made by the owning module at import time: a module that
 * is switched off today (the Machines plugin) still owns rows sealed while it
 * was on, and its rows must rotate with the rest.
 *
 * The owning module creates its table; a table that does not exist yet simply
 * holds nothing.
 */
import { db } from '../db.js';
import { ENVELOPE_PREFIX, type SecretIdentity } from './box.js';

export type SealedColumn = {
  table: string;
  /** Primary key column, bound into the identity. */
  key: string;
  column: string;
  identity: (key: string) => SecretIdentity;
};

/** Identity a machine's device token is sealed for (`machines/store.ts`). */
export function machineTokenIdentity(machineId: string): SecretIdentity {
  return { secretId: `machine:${machineId}`, name: 'DEVICE_TOKEN' };
}

/** Identity of the secret that verifies a trigger's incoming webhook calls (`triggers/store.ts`). */
export function triggerSecretIdentity(triggerId: string): SecretIdentity {
  return { secretId: `trigger:${triggerId}`, name: 'WEBHOOK_SECRET' };
}

/** Identity of the secret that signs a trigger's outgoing `webhook` actions. */
export function triggerOutboundSecretIdentity(triggerId: string): SecretIdentity {
  return { secretId: `trigger:${triggerId}`, name: 'OUTBOUND_SECRET' };
}

export const SEALED_COLUMNS: readonly SealedColumn[] = [
  { table: 'machines', key: 'id', column: 'token_enc', identity: machineTokenIdentity },
  { table: 'triggers', key: 'id', column: 'secret', identity: triggerSecretIdentity },
  { table: 'triggers', key: 'id', column: 'outbound_secret', identity: triggerOutboundSecretIdentity },
];

export type SealedColumnRow = { spec: SealedColumn; key: string; envelope: string };

function tableExists(table: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;
}

/** Every sealed value of the listed columns. Identifiers come from the static list, never from input. */
export function sealedColumnRows(): SealedColumnRow[] {
  const rows: SealedColumnRow[] = [];
  for (const spec of SEALED_COLUMNS) {
    if (!tableExists(spec.table)) continue;
    const found = db.prepare(
      `SELECT ${spec.key} AS k, ${spec.column} AS v FROM ${spec.table} WHERE substr(${spec.column}, 1, ?) = ?`,
    ).all(ENVELOPE_PREFIX.length, ENVELOPE_PREFIX) as { k: string; v: string }[];
    for (const row of found) rows.push({ spec, key: row.k, envelope: row.v });
  }
  return rows;
}

/** Writes resealed envelopes back. Called inside the rotation's transaction. */
export function replaceSealedColumnRows(rows: readonly SealedColumnRow[]): number {
  let n = 0;
  for (const row of rows) {
    n += db.prepare(`UPDATE ${row.spec.table} SET ${row.spec.column} = ? WHERE ${row.spec.key} = ?`)
      .run(row.envelope, row.key).changes;
  }
  return n;
}
