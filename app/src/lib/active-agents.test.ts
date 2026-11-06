import assert from 'node:assert/strict';
import test from 'node:test';

test('the agent views refetch on a permission card raised, answered or expired, through the shared stream', async () => {
  const sources: Source[] = [];
  const globals = globalThis as Record<string, unknown>;
  class Source extends EventTarget {
    static CLOSED = 2;
    readyState = 1;
    constructor(readonly url: string) { super(); sources.push(this); }
    close() { this.readyState = Source.CLOSED; }
  }
  globals.window = {};
  globals.EventSource = Source;
  try {
    const { onAgentStateEvent } = await import('./active-agents');
    let refetches = 0;
    const stop = onAgentStateEvent(() => { refetches++; });
    assert.equal(sources.length, 1, 'one global connection, whatever the number of names');
    const stream = sources[0]!;
    // The names the daemon sends on the global stream (sse.ts), the
    // permission ones as aliases of the card's generic `event` frame.
    for (const name of ['permission_request', 'permission_resolved', 'permission_expired', 'turn_complete', 'mission_complete']) {
      const before = refetches;
      stream.dispatchEvent(new MessageEvent(name, { data: '{}' }));
      assert.equal(refetches, before + 1, name);
    }
    stream.dispatchEvent(new MessageEvent('event', { data: '{"kind":"event","type":"assistant"}' }));
    assert.equal(refetches, 5, 'a transcript line is not a state change');
    stop();
    assert.equal(stream.readyState, Source.CLOSED, 'the last listener gone, the stream closes');
    stream.dispatchEvent(new MessageEvent('permission_request', { data: '{}' }));
    assert.equal(refetches, 5);
  } finally {
    delete globals.window;
    delete globals.EventSource;
  }
});
