import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'channels-http-'));
process.env.TEST_CHANNEL_SECRET = 'test-secret';
mkdirSync(join(process.env.TIMON_HOME, 'channels'));
writeFileSync(join(process.env.TIMON_HOME, 'channels', 'hook.json'), JSON.stringify({ type: 'webhook', default_agent: 'agent', hmac_secret_env: 'TEST_CHANNEL_SECRET' }));
const modules = Promise.all([import('../app/api/channels/[name]/inbound/route'), import('./channels/store')]);
test.after(async () => (await modules)[1].channelStore().close());

test('channel HTTP accepts into durable storage without waiting for or contacting the daemon', async () => {
  const [{ POST }] = await modules;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail('acceptance must not depend on daemon availability'); };
  try {
    const body = JSON.stringify({ event_id: 'message-1', text: 'hello' });
    const make = (signature: string) => new Request('http://test/api/channels/hook/inbound', { method: 'POST', body, headers: { 'x-timon-signature': signature } });
    const signature = createHmac('sha256', 'test-secret').update(body).digest('hex');
    const first = await POST(make(signature), { params: { name: 'hook' } });
    assert.equal(first.status, 202);
    const receipt = await first.json();
    assert.ok(receipt.receipt_id); assert.equal(receipt.mission_id, null);
    assert.equal((await (await POST(make(signature), { params: { name: 'hook' } })).json()).receipt_id, receipt.receipt_id);
    assert.equal((await POST(make('bad'), { params: { name: 'hook' } })).status, 401);
    assert.equal((await POST(make(signature), { params: { name: '../hook' } })).status, 404);
  } finally { globalThis.fetch = original; }
});

test('a configured channel identity is used for both mission creation and reply reads', async () => {
  await modules;
  process.env.TEST_CHANNEL_API_TOKEN = 'scoped-token';
  writeFileSync(join(process.env.TIMON_HOME!, 'channels', 'hook.json'), JSON.stringify({ type: 'webhook', default_agent: 'agent', hmac_secret_env: 'TEST_CHANNEL_SECRET', api_token_env: 'TEST_CHANNEL_API_TOKEN' }));
  const { processInbox, processReply } = await import('./channels/processor');
  const original = globalThis.fetch;
  const auth: string[] = [];
  globalThis.fetch = async (_url, init) => {
    auth.push(new Headers(init?.headers).get('authorization')!);
    return Response.json(init?.method === 'POST' ? { mission_id: 'scoped-mission' } : {
      id: 'scoped-mission', status: 'running', events: [{ type: 'result', payload: { result: 'done' } }],
    });
  };
  try {
    await processInbox(); await processReply();
    assert.deepEqual(auth, ['Bearer scoped-token', 'Bearer scoped-token']);
  } finally { globalThis.fetch = original; }
});
