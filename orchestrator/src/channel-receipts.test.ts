import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const { dbApi } = await import('./db.js');
const { channelReceipt, findChannelMission, serializeReceipt } = await import('./channel-receipts.js');

test('durable lookup finds an already created mission, scoped to channel and owner', () => {
  const receipt = { channel: 'tg', id: randomUUID() }, mission = randomUUID();
  dbApi.createMission(mission, 'a', 'input', { channel: 'tg', meta: { channel_receipt_id: receipt.id } });
  assert.equal(findChannelMission(receipt, null), mission);
  assert.equal(findChannelMission(receipt, 'someone-else'), undefined);
  assert.equal(findChannelMission({ ...receipt, channel: 'other' }, null), undefined);
  assert.deepEqual(channelReceipt({ source_channel: 'tg', source_meta: { channel_receipt_id: receipt.id }, idempotency_key: `channel:${receipt.id}` }), receipt);
});

test('concurrent duplicate requests serialize even if the first attempt fails', async () => {
  const seen: string[] = [];
  const first = serializeReceipt('key', async () => { seen.push('first'); await new Promise(r => setImmediate(r)); seen.push('finished'); throw new Error('lost reply'); });
  const second = serializeReceipt('key', async () => { seen.push('second'); });
  await assert.rejects(first); await second;
  assert.deepEqual(seen, ['first', 'finished', 'second']);
});
