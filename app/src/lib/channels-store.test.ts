import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelStore } from './channels/store';
import { processInbox } from './channels/processor';
const inbound = { channel: 'tg', text: 'hello', replyContext: { chat_id: 42 } };

test('receipts deduplicate across connections and survive restart, expired claims recover', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'channel-store-')), 'channels.db');
  const a = new ChannelStore(path), b = new ChannelStore(path);
  const row = a.accept(inbound, 'agent', 'event-1', 1);
  assert.equal(b.accept(inbound, 'agent', 'event-1').id, row.id);
  assert.notEqual(b.accept({ ...inbound, channel: 'other' }, 'agent', 'event-1').id, row.id);
  const claimed = a.claimInbox(1)!;
  assert.equal(claimed.id, row.id);
  assert.notEqual(b.claimInbox(1)?.id, row.id);
  a.close();
  const recovered = b.claimInbox(120_002)!;
  assert.equal(recovered.id, row.id);
  b.completeInbox(claimed, 'stale');
  assert.equal(b.getReply('stale'), undefined);
  b.completeInbox(recovered, 'mission');
  assert.equal(b.getReply('mission')!.channel, 'tg');
  b.setCursor('tg', 12); b.setCursor('tg', 10); b.close();
  const reopened = new ChannelStore(path);
  assert.equal(reopened.cursor('tg'), 12);
  assert.equal(reopened.accept(inbound, 'agent', 'event-1').mission_id, 'mission');
  reopened.close();
});

test('failed spawn retries with the same durable receipt and idempotency key', async () => {
  const store = new ChannelStore(join(mkdtempSync(join(tmpdir(), 'channel-retry-')), 'channels.db'));
  const receipt = store.accept(inbound, 'agent', 'event');
  const keys: unknown[] = [];
  await processInbox(store, async input => { keys.push(input.idempotencyKey); throw new Error('lost response'); });
  assert.equal(store.claimInbox(), undefined);
  store.db.prepare('UPDATE inbox SET next_at=0').run();
  await processInbox(store, async input => { keys.push(input.idempotencyKey); return 'mission'; });
  assert.deepEqual(keys, [`channel:${receipt.id}`, `channel:${receipt.id}`]);
  assert.ok(store.getReply('mission'));
  assert.equal(await processInbox(store, async () => { throw new Error('must not spawn'); }), false);
  store.close();
});

test('legacy reply mappings import exactly once without resurrecting delivered replies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-legacy-'));
  const path = join(dir, 'channels.db'), legacy = join(dir, 'old.json');
  writeFileSync(legacy, JSON.stringify({ mission: { channel: 'tg', replyContext: { chat_id: 42 } } }));
  const first = new ChannelStore(path, legacy);
  assert.ok(first.getReply('mission')); first.completeReply('mission'); first.close();
  const second = new ChannelStore(path, legacy);
  assert.equal(second.getReply('mission'), undefined); second.close();
});

test('ingress budget is durable and duplicate delivery does not consume another slot', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'channel-budget-')), 'channels.db');
  const a = new ChannelStore(path), b = new ChannelStore(path);
  const now = Date.now();
  for (let i = 0; i < 30; i++) a.accept(inbound, 'agent', `event-${i}`, now);
  assert.throws(() => b.accept(inbound, 'agent', 'extra', now), /rate limited/);
  assert.ok(b.accept(inbound, 'agent', 'event-0', now));
  assert.ok(b.accept(inbound, 'agent', 'extra', now + 60_001));
  a.close(); b.close();
});
