import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'channels-wa-'));
mkdirSync(join(process.env.ROOKS_HOME, 'channels'), { recursive: true });
process.env.WHATSAPP_ACCESS_TOKEN = 'access-token';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.WHATSAPP_APP_SECRET = 'app-secret';
process.env.WHATSAPP_WEB_WORKER_SECRET = 'worker-secret';

const modules = Promise.all([
  import('./channels/config'),
  import('./channels/inbound'),
  import('./channels/whatsapp-cloud-api'),
  import('./channels/transports/whatsapp-cloud'),
  import('./channels/transports/whatsapp-web'),
  import('./channels/whatsapp-web-copy'),
  import('./channels/replyDispatcher'),
]);

async function loaded() {
  const [config, inbound, cloudApi, cloudTransport, webTransport, copy, dispatcher] = await modules;
  return { config, inbound, cloudApi, cloudTransport, webTransport, copy, dispatcher };
}

const metaBody = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      value: {
        messages: [{
          from: '15551234567',
          id: 'wamid.ABC',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'hello from wa' },
        }],
      },
    }],
  }],
});

test('WhatsApp Cloud config validates phone id and env keys', async () => {
  const { config } = await loaded();
  const cloudCfg = config.validateChannelConfig({
    type: 'whatsapp-cloud',
    default_agent: 'main',
    phone_number_id: '123456789012345',
    access_token_env: 'WHATSAPP_ACCESS_TOKEN',
    verify_token_env: 'WHATSAPP_VERIFY_TOKEN',
    app_secret_env: 'WHATSAPP_APP_SECRET',
    allowed_from: ['15551234567'],
  });
  assert.equal(cloudCfg.type, 'whatsapp-cloud');
  assert.throws(() => config.validateChannelConfig({ ...cloudCfg as object, phone_number_id: 'abc' }));
});

test('Meta hub challenge accepts the verify token and rejects others', async () => {
  const { config, inbound } = await loaded();
  const cloudCfg = config.validateChannelConfig({
    type: 'whatsapp-cloud',
    default_agent: 'main',
    phone_number_id: '123456789012345',
    access_token_env: 'WHATSAPP_ACCESS_TOKEN',
    verify_token_env: 'WHATSAPP_VERIFY_TOKEN',
    app_secret_env: 'WHATSAPP_APP_SECRET',
  });
  const ok = new URL('http://local/api/channels/wa/inbound?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
  assert.equal(inbound.verifyWhatsAppCloudChallenge(cloudCfg, ok), '12345');
  const bad = new URL('http://local/api/channels/wa/inbound?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1');
  assert.throws(() => inbound.verifyWhatsAppCloudChallenge(cloudCfg, bad), (e: unknown) =>
    e instanceof inbound.InboundError && e.status === 403);
});

test('WhatsApp Cloud inbound verifies X-Hub-Signature-256 and allowlist', async () => {
  const { config, inbound } = await loaded();
  const cloudCfg = config.validateChannelConfig({
    type: 'whatsapp-cloud',
    default_agent: 'main',
    phone_number_id: '123456789012345',
    access_token_env: 'WHATSAPP_ACCESS_TOKEN',
    verify_token_env: 'WHATSAPP_VERIFY_TOKEN',
    app_secret_env: 'WHATSAPP_APP_SECRET',
    allowed_from: ['15551234567'],
  });
  const sig = createHmac('sha256', 'app-secret').update(metaBody).digest('hex');
  const headers = new Headers({ 'x-hub-signature-256': `sha256=${sig}` });
  const msg = inbound.normalizeInbound('wa', cloudCfg, metaBody, headers);
  assert.equal(msg.externalId, 'whatsapp-cloud:wamid.ABC');
  assert.equal(msg.text, 'hello from wa');
  assert.deepEqual(msg.replyContext, { from: '15551234567' });

  assert.throws(
    () => inbound.normalizeInbound('wa', cloudCfg, metaBody, new Headers({ 'x-hub-signature-256': 'sha256=deadbeef' })),
    (e: unknown) => e instanceof inbound.InboundError && e.status === 401,
  );

  const denied = metaBody.replace('15551234567', '19999999999');
  const deniedSig = createHmac('sha256', 'app-secret').update(denied).digest('hex');
  assert.throws(
    () => inbound.normalizeInbound('wa', cloudCfg, denied, new Headers({ 'x-hub-signature-256': `sha256=${deniedSig}` })),
    (e: unknown) => e instanceof inbound.InboundError && e.status === 403,
  );
});

test('extractWhatsAppCloudMessage ignores non-text payloads', async () => {
  const { cloudApi } = await loaded();
  assert.equal(cloudApi.extractWhatsAppCloudMessage({ entry: [] }), null);
  assert.equal(cloudApi.extractWhatsAppCloudMessage({ entry: [{ changes: [{ value: { messages: [{ type: 'image' }] } }] }] }), null);
});

test('WhatsApp Cloud reply posts Graph messages and chunks long text', async () => {
  const { config, cloudApi, cloudTransport } = await loaded();
  const cloudCfg = config.validateChannelConfig({
    type: 'whatsapp-cloud',
    default_agent: 'main',
    phone_number_id: '123456789012345',
    access_token_env: 'WHATSAPP_ACCESS_TOKEN',
    verify_token_env: 'WHATSAPP_VERIFY_TOKEN',
  });
  assert.deepEqual(cloudApi.chunkText('abcd', 2), ['ab', 'cd']);
  const original = globalThis.fetch;
  const posts: unknown[] = [];
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ messages: [{ id: '1' }] }), { status: 200 });
  };
  try {
    await cloudTransport.replyWhatsAppCloud(cloudCfg, { from: '15551234567' }, 'hi');
    assert.equal(posts.length, 1);
    assert.match(String((posts[0] as { url: string }).url), /\/123456789012345\/messages$/);
    await cloudApi.sendWhatsAppCloudMessage(cloudCfg, '15551234567', 'x'.repeat(4001));
    assert.equal(posts.length, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test('WhatsApp Web worker signature and reply outbox', async () => {
  const { config, inbound, webTransport, dispatcher } = await loaded();
  const webCfg = config.validateChannelConfig({
    type: 'whatsapp-web',
    default_agent: 'main',
    worker_secret_env: 'WHATSAPP_WEB_WORKER_SECRET',
  });
  config.saveChannelConfig('whatsapp', webCfg);
  const body = JSON.stringify({ jid: '15551234567@s.whatsapp.net', message_id: 'm1', text: 'ping' });
  const msg = inbound.normalizeInbound('whatsapp', webCfg, body, new Headers(inbound.whatsappWebHeaders(body, 'worker-secret')));
  assert.equal(msg.externalId, 'whatsapp-web:m1');
  assert.deepEqual(msg.replyContext, { jid: '15551234567@s.whatsapp.net' });

  let sent: { jid: string; text: string } | null = null;
  webTransport.setWhatsAppWebSenderForTests(async (_cfg, jid, text) => { sent = { jid, text }; });
  try {
    await webTransport.replyWhatsAppWeb(webCfg, { jid: '15551234567@s.whatsapp.net' }, 'pong');
    assert.deepEqual(sent, { jid: '15551234567@s.whatsapp.net', text: 'pong' });
    await dispatcher.dispatchReply({
      channelName: 'whatsapp',
      replyContext: { jid: '15551234567@s.whatsapp.net' },
      text: 'via dispatcher',
      missionId: 'm',
    });
    assert.equal(sent?.text, 'via dispatcher');
  } finally {
    webTransport.setWhatsAppWebSenderForTests(null);
  }
});

test('allowlist helper and browser-safe risk copy have no Node imports', async () => {
  const { cloudTransport, copy } = await loaded();
  assert.equal(cloudTransport.isAllowedWhatsAppFrom({}, '1'), true);
  assert.equal(cloudTransport.isAllowedWhatsAppFrom({ allowed_from: ['1555'] }, '1555'), true);
  assert.equal(cloudTransport.isAllowedWhatsAppFrom({ allowed_from: ['1555'] }, '999'), false);
  assert.ok(copy.WHATSAPP_WEB_RISKS.length >= 3);
});

test('upsertSecretsEnv writes secrets.env and mirrors process.env', async () => {
  const { config } = await loaded();
  const file = join(process.env.ROOKS_HOME!, 'secrets.env');
  config.upsertSecretsEnv({ WHATSAPP_TEST_KEY: 'value-1' }, file);
  assert.ok(existsSync(file));
  assert.equal(config.parseEnvFile(readFileSync(file, 'utf8')).WHATSAPP_TEST_KEY, 'value-1');
  assert.equal(process.env.WHATSAPP_TEST_KEY, 'value-1');
  writeFileSync(join(process.env.ROOKS_HOME!, 'channels', 'cloud.json'), JSON.stringify({
    type: 'whatsapp-cloud',
    default_agent: 'main',
    phone_number_id: '123456789012345',
    access_token_env: 'WHATSAPP_ACCESS_TOKEN',
    verify_token_env: 'WHATSAPP_VERIFY_TOKEN',
  }));
});
