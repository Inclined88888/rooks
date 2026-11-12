import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelStore } from './channels/store';
import { completedReply, processReply } from './channels/processor';
import { sendMessage } from './channels/telegram-api';
import type { MissionDetails } from './orchestrator';
const mission: MissionDetails = { id: 'mission', agent_name: 'a', mission: 'hello', status: 'running', running: true, turn_active: false, started_at: 1, ended_at: null, exit_code: null, source_channel: 'tg', events: [
  { id: 1, type: 'assistant', timestamp: 1, payload: { message: { content: [{ type: 'text', text: 'Working on it' }] } } },
  { id: 2, type: 'assistant', timestamp: 2, payload: { message: { content: [{ type: 'text', text: 'Final answer' }] } } },
  { id: 3, type: 'result', timestamp: 3, payload: { is_error: false } },
] };

test('answer is ready at the end of a turn, without mission_complete or intermediate text', () => {
  assert.equal(completedReply(mission), 'Final answer');
  assert.equal(completedReply({ ...mission, events: mission.events.slice(0, 2), turn_active: true }), undefined);
  assert.equal(completedReply({ ...mission, status: 'failed', events: [] }), '(mission failed or stopped — no text output)');
});

test('offline completion is recovered; failed delivery retries the saved text and chunk cursor after restart', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'channel-replies-')), 'channels.db');
  let store = new ChannelStore(path);
  store.addReply('mission', 'tg', { chat_id: 42 });
  let sent = 0;
  await processReply(store, async () => mission, async args => {
    assert.equal(args.text, 'Final answer'); args.onPart!(1); sent++; throw new Error('second chunk failed');
  });
  assert.ok(store.getReply('mission')); store.close();
  store = new ChannelStore(path);
  store.db.prepare('UPDATE replies SET next_at=0').run();
  await processReply(store, async () => { throw new Error('saved response must not be recomputed'); }, async args => {
    assert.equal(args.startPart, 1); assert.equal(args.text, 'Final answer'); sent++;
  });
  assert.equal(store.getReply('mission'), undefined);
  assert.equal(await processReply(store, async () => mission, async () => { sent++; }), false);
  assert.equal(sent, 2); store.close();
});

test('live missions defer without sending and workers cannot claim the same reply', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'channel-claims-')), 'channels.db');
  const a = new ChannelStore(path), b = new ChannelStore(path);
  a.addReply('mission', 'tg', {});
  await processReply(a, async () => ({ ...mission, events: [] }), async () => { assert.fail('not finished'); });
  assert.equal(b.claimReply(), undefined);
  const row = b.claimReply(Date.now() + 6000)!;
  assert.equal(a.claimReply(Date.now() + 6000), undefined);
  a.completeReply('mission', 'stale'); assert.ok(b.getReply('mission'));
  b.completeReply('mission', row.lease); a.close(); b.close();
});

test('Telegram persists progress after each successful chunk and resumes at the failed chunk', async () => {
  const original = globalThis.fetch;
  const sent: string[] = [];
  let next = 0;
  globalThis.fetch = async (_url, init) => {
    const text = JSON.parse(init!.body as string).text;
    sent.push(text);
    return new Response(JSON.stringify({ ok: sent.length !== 2 }), { status: sent.length === 2 ? 500 : 200 });
  };
  try {
    const text = 'a'.repeat(3800) + 'b'.repeat(20);
    await assert.rejects(sendMessage('secret', 42, text, { onPart: part => { next = part; } }));
    assert.equal(next, 1);
    await sendMessage('secret', 42, text, { startPart: next, onPart: part => { next = part; } });
    assert.deepEqual(sent.map(s => s[0]), ['a', 'b', 'b']); assert.equal(next, 2);
  } finally { globalThis.fetch = original; }
});
