import assert from 'node:assert/strict';
import test from 'node:test';
import { createClientRealtime } from './plugin-host/realtime';
import { clientContext } from './plugin-host/loader';
import type { sseOn } from './sse-stream';

function mockSse() {
  const listeners = new Map<string, (event: MessageEvent) => void>();
  let removals = 0;
  const subscribe: typeof sseOn = (name, handler) => {
    listeners.set(name, handler);
    return () => { removals++; listeners.delete(name); };
  };
  return { listeners, subscribe, removals: () => removals };
}

for (const id of ['example-realtime', '@rooks/kanban']) {
  test(`realtime scopes ${id}, unwraps payload and cleans up once`, () => {
    const sse = mockSse();
    const cleanup: Array<() => void> = [];
    const realtime = createClientRealtime(id, (fn) => cleanup.push(fn), sse.subscribe);
    const payloads: unknown[] = [];
    const off = realtime.subscribe('changed', (payload) => payloads.push(payload));
    assert.deepEqual([...sse.listeners.keys()], [`plugin:${id}:changed`]);
    for (const payload of [{ revision: 2 }, null, false, 0, ['a']]) {
      sse.listeners.get(`plugin:${id}:changed`)!(new MessageEvent('message', {
        data: JSON.stringify({ plugin: id, topic: 'changed', payload }),
      }));
      assert.deepEqual(payloads.at(-1), payload);
    }
    off();
    cleanup.forEach((fn) => fn());
    assert.equal(sse.listeners.size, 0);
    assert.equal(sse.removals(), 1);
  });
}

test('clientContext validates topics before subscribing and disposes listeners', () => {
  const sse = mockSse();
  const ctx = clientContext('example-realtime', [], sse.subscribe);
  for (const topic of ['', ':changed', 'other:changed', 'Changed', 'a b', 'a\n', '-a', 'a'.repeat(65)]) {
    assert.throws(() => ctx.realtime.subscribe(topic, () => {}), /Invalid plugin realtime topic/);
  }
  assert.equal(sse.listeners.size, 0);
  let received: unknown;
  ctx.realtime.subscribe('changed', (payload) => { received = payload; });
  assert.deepEqual([...sse.listeners.keys()], ['plugin:example-realtime:changed']);
  sse.listeners.get('plugin:example-realtime:changed')!(new MessageEvent('message', {
    data: JSON.stringify({ plugin: 'example-realtime', topic: 'changed', payload: { changed: true } }),
  }));
  assert.deepEqual(received, { changed: true });
  ctx.realtime.subscribe('a'.repeat(64), () => {});
  ctx.realtime.subscribe('0._-z', () => {});
  ctx.dispose();
  ctx.dispose();
  assert.equal(sse.listeners.size, 0);
  assert.equal(sse.removals(), 3);
});
