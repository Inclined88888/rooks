import { db } from './db.js';

type ReceiptBody = { source_channel?: string; source_meta?: unknown; idempotency_key?: string };
export function channelReceipt(body: ReceiptBody): { channel: string; id: string } | undefined {
  const meta = body.source_meta as { channel_receipt_id?: unknown } | null;
  const id = meta?.channel_receipt_id;
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || body.idempotency_key !== `channel:${id}` || typeof body.source_channel !== 'string') return;
  return { channel: body.source_channel, id };
}
export function findChannelMission(receipt: { channel: string; id: string }, owner: string | null): string | undefined {
  const row = db.prepare(`SELECT id FROM missions WHERE source_channel=? AND owner_user_id IS ?
    AND json_valid(source_meta) AND json_extract(source_meta,'$.channel_receipt_id')=? LIMIT 1`).get(receipt.channel, owner, receipt.id) as { id: string } | undefined;
  return row?.id;
}
const pending = new Map<string, Promise<void>>();
/** Serialize duplicate HTTP attempts while spawnAgent is awaiting its backend. */
export async function serializeReceipt(key: string, work: () => Promise<void>): Promise<void> {
  const previous = pending.get(key);
  let release!: () => void;
  const own = new Promise<void>(resolve => { release = resolve; });
  pending.set(key, own);
  try { await previous; await work(); }
  finally { release(); if (pending.get(key) === own) pending.delete(key); }
}
