/**
 * "Test" of a user-added backend — three answers a human can act on, and a key
 * that appears in none of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelsUrl, testBackendConnection } from './connection-test.js';

const KEY = 'sk-witness-4f1c9a';

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

test('each protocol lists its models where its CLI expects the base URL to end', () => {
  assert.equal(modelsUrl('anthropic', 'https://a.test/anthropic/'), 'https://a.test/anthropic/v1/models');
  assert.equal(modelsUrl('openai-responses', 'https://a.test/v1'), 'https://a.test/v1/models');
});

test('2xx → ok, with the models the endpoint lists', async () => {
  const { fetch, calls } = fakeFetch(() => Response.json({ data: [{ id: 'm-1' }, { id: 'm-2' }, { nope: true }] }));
  const out = await testBackendConnection({ protocol: 'openai-responses', baseUrl: 'https://a.test/v1', key: KEY }, fetch);
  assert.deepEqual(out, { outcome: 'ok', status: 200, models: ['m-1', 'm-2'] });
  assert.equal((calls[0]!.init.headers as Record<string, string>)['authorization'], `Bearer ${KEY}`);
  assert.equal(calls[0]!.init.redirect, 'manual', 'the key was given for one host');
});

test('401 and 403 → key-refused', async () => {
  for (const status of [401, 403]) {
    const { fetch } = fakeFetch(() => new Response(`invalid key ${KEY}`, { status }));
    assert.deepEqual(await testBackendConnection({ protocol: 'anthropic', baseUrl: 'https://a.test', key: KEY }, fetch), { outcome: 'key-refused', status });
  }
});

test('no HTTP answer → unreachable', async () => {
  const { fetch } = fakeFetch(() => { throw new TypeError(`fetch failed for Bearer ${KEY}`); });
  assert.deepEqual(await testBackendConnection({ protocol: 'anthropic', baseUrl: 'https://a.test', key: KEY }, fetch), { outcome: 'unreachable' });
});

test('an answer that says nothing about the key is reported as it is', async () => {
  const { fetch } = fakeFetch(() => new Response('', { status: 404 }));
  assert.deepEqual(await testBackendConnection({ protocol: 'anthropic', baseUrl: 'https://a.test', key: KEY }, fetch), { outcome: 'unexpected-status', status: 404 });
});

test('the key never appears in an outcome, even when the provider echoes it', async () => {
  const responders: (() => Response)[] = [
    () => Response.json({ data: [{ id: 'm' }], echoed: KEY }),
    () => new Response(KEY, { status: 401 }),
    () => new Response(KEY, { status: 500 }),
    () => new Response(KEY, { status: 200 }),
    () => { throw new Error(KEY); },
  ];
  for (const respond of responders) {
    const { fetch } = fakeFetch(respond);
    const out = await testBackendConnection({ protocol: 'openai-responses', baseUrl: 'https://a.test/v1', key: KEY }, fetch);
    assert.doesNotMatch(JSON.stringify(out), /sk-witness/);
  }
});

test('no key, no credential header', async () => {
  const { fetch, calls } = fakeFetch(() => Response.json({ data: [] }));
  await testBackendConnection({ protocol: 'anthropic', baseUrl: 'http://127.0.0.1:1234', key: '' }, fetch);
  assert.deepEqual(Object.keys(calls[0]!.init.headers as Record<string, string>), ['accept']);
});

test('Anthropic `capabilities.effort` → the supported levels of each model, in ladder order', async () => {
  const { fetch } = fakeFetch(() => Response.json({ data: [
    { id: 'claude-opus-5-5', capabilities: { batch: { supported: true }, effort: {
      high: { supported: true }, low: { supported: true }, max: { supported: true },
      medium: { supported: true }, supported: true, xhigh: { supported: false }, 'Bad Name': { supported: true },
    } } },
    { id: 'claude-haiku-4-5', capabilities: { effort: { supported: false } } },
    { id: 'no-capabilities' },
  ] }));
  const out = await testBackendConnection({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.test', key: KEY }, fetch);
  assert.deepEqual(out, {
    outcome: 'ok', status: 200, models: ['claude-opus-5-5', 'claude-haiku-4-5', 'no-capabilities'],
    reasoningLevels: { 'claude-opus-5-5': ['low', 'medium', 'high', 'max'], 'claude-haiku-4-5': [] },
  });
});

test('a listing without capabilities (B.AI) reports no levels', async () => {
  const { fetch } = fakeFetch(() => Response.json({ data: [
    { id: 'qwen3.8-max', object: 'model', created: 1, owned_by: 'qwen', supported_endpoint_types: ['openai', 'anthropic'] },
  ] }));
  const out = await testBackendConnection({ protocol: 'anthropic', baseUrl: 'https://api.b.test', key: KEY }, fetch);
  assert.deepEqual(out, { outcome: 'ok', status: 200, models: ['qwen3.8-max'] });
});

test('effort capabilities are read on the Anthropic protocol only', async () => {
  const { fetch } = fakeFetch(() => Response.json({ data: [{ id: 'm', capabilities: { effort: { supported: true, low: { supported: true } } } }] }));
  const out = await testBackendConnection({ protocol: 'openai-responses', baseUrl: 'https://a.test/v1', key: KEY }, fetch);
  assert.deepEqual(out, { outcome: 'ok', status: 200, models: ['m'] });
});
