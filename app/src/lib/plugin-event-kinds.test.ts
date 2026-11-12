import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { sseOn } from './sse-stream';
import { clientContext } from './plugin-host/loader';
import { PLUGIN_EVENT_KINDS } from './plugin-host/event-kinds';

type Listener = (event: MessageEvent) => void;

function fakeSse() {
  const subscribed: string[] = [];
  const listeners = new Map<string, Listener>();
  const subscribe: typeof sseOn = (kind, listener) => {
    subscribed.push(kind);
    listeners.set(kind, listener);
    return () => { listeners.delete(kind); };
  };
  return { subscribe, subscribed, listeners };
}

test('the browser allowlist is the host allowlist', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, '..', '..', '..', 'orchestrator', 'src', 'plugins', 'contract', 'events.ts'), 'utf8');
  const block = /export const PLUGIN_EVENT_KINDS = Object\.freeze\(\[([\s\S]*?)\]/.exec(source);
  assert.ok(block, 'PLUGIN_EVENT_KINDS not found in the host contract');
  const hostKinds = [...(block[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...PLUGIN_EVENT_KINDS], hostKinds);
});

test('a browser half cannot listen to mission transcripts', () => {
  const sse = fakeSse();
  const ctx = clientContext('acme', [], sse.subscribe);
  for (const kind of ['event', 'event_delta', 'plugins_changed', 'plugin:other:topic', '']) {
    assert.throws(() => ctx.events.subscribe(kind, () => {}), /not exposed to plugins/);
  }
  assert.deepEqual(sse.subscribed, [], 'a refused kind never reaches the stream');
});

test('an allowed kind is delivered and released on dispose', () => {
  const sse = fakeSse();
  const ctx = clientContext('acme', [], sse.subscribe);
  const received: unknown[] = [];
  ctx.events.subscribe('task_done', (event) => { received.push(event); });
  sse.listeners.get('task_done')?.(new MessageEvent('task_done', { data: '{"id":"t1"}' }));
  assert.deepEqual(received, [{ id: 't1' }]);
  ctx.dispose();
  assert.equal(sse.listeners.has('task_done'), false);
});

test('mission lifecycle kinds are allowed without any permission', () => {
  const sse = fakeSse();
  const ctx = clientContext('acme', [], sse.subscribe);
  ctx.events.subscribe('mission_started', () => {});
  ctx.events.subscribe('turn_complete', () => {});
  assert.deepEqual(sse.subscribed, ['mission_started', 'turn_complete']);
  ctx.dispose();
});

test('the transcript row stream needs missions:transcript in the manifest; deltas never reach the browser', () => {
  const refused = fakeSse();
  assert.throws(() => clientContext('acme', [], refused.subscribe, ['missions:read']).events.subscribe('event', () => {}), /not exposed to plugins/);
  assert.deepEqual(refused.subscribed, []);
  const granted = fakeSse();
  const ctx = clientContext('acme', [], granted.subscribe, ['missions:transcript']);
  const received: unknown[] = [];
  ctx.events.subscribe('event', (event) => { received.push(event); });
  granted.listeners.get('event')?.(new MessageEvent('event', { data: '{"kind":"event","missionId":"m1","type":"assistant","timestamp":1,"payload":{}}' }));
  assert.equal((received[0] as { missionId: string }).missionId, 'm1');
  assert.throws(() => ctx.events.subscribe('event_delta', () => {}), /not exposed to plugins/, 'the permission does not open the live fragments');
  ctx.dispose();
});
