/**
 * The outbox under the operator's REAL network policy (TODO #599): a host
 * opened to one plugin in `pluginPolicy.http.byPlugin` carries that plugin's
 * queued calls and nobody else's, at the post and again at delivery.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-outbox-policy-'));

const { createPluginOutbox, PluginOutboxError } = await import('./outbox.js');
const { assertFetchAllowed } = await import('./policy.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');

const URL_A = 'https://hooks.a.example/in';

function outboxUnderPolicy() {
  const sent: string[] = [];
  const outbox = createPluginOutbox({
    fetch: (async (input: Parameters<typeof fetch>[0]) => { sent.push(String(input)); return new Response('ok'); }) as typeof fetch,
    secret: () => undefined,
    allow: (pluginId, url) => assertFetchAllowed(pluginId, url),
    now: () => 1_000_000,
    schedule: false,
  });
  return { outbox, sent };
}

test.after(() => resetConfig());

test('a byPlugin host takes the calls of its plugin, and refuses another plugin at the post', async () => {
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { http: { byPlugin: { 'outbox-a': ['hooks.a.example'] } } } }));
  const { outbox, sent } = outboxUnderPolicy();
  assert.throws(() => outbox.enqueue('outbox-b', URL_A, { n: 1 }, {}),
    (err: unknown) => err instanceof PluginOutboxError && err.code === 'not_allowed');
  const id = outbox.enqueue('outbox-a', URL_A, { n: 1 }, {});
  const detach = outbox.attach('outbox-a');
  try {
    assert.equal(await outbox.deliverDue(), 1);
    assert.deepEqual(sent, [URL_A]);
    assert.equal(outbox.get('outbox-a', id)?.state, 'delivered');
  } finally {
    detach();
  }
});

test('a call queued while the host was opened fails, unsent, once the entry is gone', async () => {
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { http: { byPlugin: { 'outbox-c': ['hooks.a.example'] } } } }));
  const { outbox, sent } = outboxUnderPolicy();
  const id = outbox.enqueue('outbox-c', URL_A, { n: 1 }, {});
  // The plugin was removed (or the operator closed the host) before delivery.
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { http: { byPlugin: {} } } }));
  const detach = outbox.attach('outbox-c');
  try {
    assert.equal(await outbox.deliverDue(), 0);
    assert.deepEqual(sent, []);
    const entry = outbox.get('outbox-c', id);
    assert.deepEqual([entry?.state, entry?.last_error], ['failed', 'host not allowed by pluginPolicy.http']);
  } finally {
    detach();
  }
});
