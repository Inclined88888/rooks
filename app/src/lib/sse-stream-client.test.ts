import assert from 'node:assert/strict';
import test from 'node:test';

test('the global stream and per-kind streams name themselves with a well-formed, unique id', async () => {
  const sources: string[] = [];
  const globals = globalThis as Record<string, unknown>;
  class Source extends EventTarget {
    static CLOSED = 2;
    readyState = 1;
    constructor(readonly url: string) { super(); sources.push(url); }
    close() { this.readyState = Source.CLOSED; }
  }
  globals.window = {};
  globals.EventSource = Source;
  try {
    const { sseOn, streamClientQuery } = await import('./sse-stream');
    const stop = sseOn('task_done', () => {});
    stop();
    assert.equal(sources.length, 1);
    const wellFormed = /^[A-Za-z0-9._-]{1,64}$/; // what the proxy and the daemon accept
    const [path, query] = sources[0]!.split('?');
    assert.equal(path, '/api/ui/stream');
    const id = new URLSearchParams(query).get('client')!;
    assert.match(id, wellFormed);
    assert.ok(id.endsWith('.g'));

    const chatA = new URLSearchParams(streamClientQuery('c')).get('client')!;
    const chatB = new URLSearchParams(streamClientQuery('c')).get('client')!;
    const voice = new URLSearchParams(streamClientQuery('v')).get('client')!;
    for (const other of [chatA, chatB, voice]) {
      assert.match(other, wellFormed);
      assert.equal(other.split('.')[0], id.split('.')[0], 'one document id for every stream of this window');
    }
    assert.notEqual(chatA, chatB, 'two chats on one mission never evict each other');
    assert.notEqual(chatA, voice);
  } finally {
    delete globals.window;
    delete globals.EventSource;
  }
});
