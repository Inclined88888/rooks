import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { normalizeInbound, telegramHeaders, readInboundBody, InboundError } from './channels/inbound';
import { verifyHmac } from './channels/hmac';
import { validateChannelConfig } from './channels/config';
import { replyWebhook } from './channels/transports/webhook';

process.env.TEST_CHANNEL_TOKEN = 'test-secret';
const telegram = { type: 'telegram' as const, bot_token_env: 'TEST_CHANNEL_TOKEN', default_agent: 'agent', allowed_chat_ids: [42] };
const message = JSON.stringify({ message: { message_id: 1, chat: { id: 42 }, text: 'hello' } });
const rejects = (status: number) => (error: unknown) => error instanceof InboundError && error.status === status;

test('Telegram rejects spoofed chats and stale worker signatures, accepts signed worker messages', () => {
  assert.throws(() => normalizeInbound('tg', telegram, message, new Headers()), rejects(401));
  assert.throws(() => normalizeInbound('tg', telegram, message, new Headers(telegramHeaders(message, 'wrong'))), rejects(401));
  const time = 1_700_000_000_000;
  assert.throws(() => normalizeInbound('tg', telegram, message, new Headers(telegramHeaders(message, 'test-secret', time)), time + 300_001), rejects(401));
  assert.equal(normalizeInbound('tg', telegram, message, new Headers(telegramHeaders(message, 'test-secret'))).externalId, 'telegram:42:1');
  const denied = message.replace('42', '43');
  assert.throws(() => normalizeInbound('tg', telegram, denied, new Headers(telegramHeaders(denied, 'test-secret'))), rejects(403));
});

test('signed invalid JSON and malformed envelopes return a client error', () => {
  for (const raw of ['{', 'null', '{"message":{}}']) assert.throws(() => normalizeInbound('tg', telegram, raw, new Headers(telegramHeaders(raw, 'test-secret'))), rejects(400));
});

test('HMAC rejects noncanonical signatures and missing required prefixes', () => {
  const sig = createHmac('sha256', 'secret').update('body').digest('hex');
  assert.equal(verifyHmac('secret', 'body', sig + 'zz'), false);
  assert.equal(verifyHmac('secret', 'body', sig, 'sha256='), false);
  assert.equal(verifyHmac('secret', 'body', 'sha256=' + sig, 'sha256='), true);
});

test('inbound body is bounded while reading and configuration is validated', async () => {
  await assert.rejects(readInboundBody(new Request('http://test', { method: 'POST', body: 'x'.repeat(256 * 1024 + 1) })), rejects(413));
  assert.throws(() => validateChannelConfig({ ...telegram, allowed_chat_ids: ['42'] }));
  assert.throws(() => validateChannelConfig({ type: 'surprise', default_agent: 'a' }));
});

test('webhook senders cannot choose the callback destination or receive its token', async () => {
  const cfg = { type: 'webhook' as const, default_agent: 'agent', hmac_secret_env: 'TEST_CHANNEL_TOKEN', reply_url: 'https://trusted.example/reply', reply_token_env: 'TEST_CHANNEL_TOKEN' };
  const raw = JSON.stringify({ text: 'hello', reply_url: 'https://untrusted.example' });
  assert.throws(() => normalizeInbound('hook', cfg, raw, new Headers({ 'x-timon-signature': createHmac('sha256', 'test-secret').update(raw).digest('hex') })), rejects(400));
  const original = globalThis.fetch;
  let destination: unknown, options: RequestInit | undefined;
  globalThis.fetch = async (url, init) => { destination = url; options = init; return new Response('{}'); };
  try {
    await replyWebhook(cfg, { reply_url: 'http://127.0.0.1/private' }, 'reply', 'mission');
    assert.equal(destination, cfg.reply_url);
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer test-secret');
  } finally { globalThis.fetch = original; }
});
