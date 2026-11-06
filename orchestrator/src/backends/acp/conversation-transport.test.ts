/**
 * The ACP client over a conversation the daemon opened for a provider
 * (`conversation-transport.ts`): bytes cross both ways, the end of the process
 * ends the client, and `stop()` hands the process back to the daemon exactly once.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpTransportError } from './transport.js';

const { acpTransportOver } = await import('./conversation-transport.js');

type Listener = (chunk: Uint8Array) => void;

/** A conversation with a scripted peer: `reply` decides what stdout says to each line written. */
function peer(reply: (line: string, say: (text: string) => void, end: () => void) => void) {
  const listeners = new Set<Listener>();
  let end!: () => void;
  const exited = new Promise<void>((resolve) => { end = resolve; });
  const written: string[] = [];
  let stops = 0;
  const say = (text: string): void => { for (const l of [...listeners]) l(Buffer.from(text)); };
  return {
    written,
    stops: () => stops,
    conversation: {
      cwd: '/home/timon',
      write(data: string | Uint8Array) {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString();
        for (const line of text.split('\n').filter(Boolean)) { written.push(line); reply(line, say, end); }
      },
      onData(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      exited,
      stderr: () => 'tail',
      async stop() { stops += 1; end(); },
    },
  };
}

test('requests go out as lines and the answers come back through onData', async () => {
  const agent = peer((line, say) => {
    const m = JSON.parse(line) as { id: number; method: string };
    say(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, authMethods: [] } })}\n`);
  });
  const channel = acpTransportOver(agent.conversation);
  try {
    assert.equal(channel.cwd, '/home/timon');
    assert.equal(channel.stderr(), 'tail');
    const init = await channel.transport.initialize();
    assert.deepEqual(init.authMethods, []);
    assert.equal(JSON.parse(agent.written[0]!).method, 'initialize');
  } finally {
    await channel.stop();
  }
});

test('a process that ends mid-request fails the request, it does not hang it', async () => {
  const agent = peer((_line, _say, end) => end());
  const channel = acpTransportOver(agent.conversation, { requestTimeoutMs: 5_000 });
  try {
    await assert.rejects(channel.transport.initialize(), (err: unknown) => err instanceof AcpTransportError);
  } finally {
    await channel.stop();
  }
});

test('stop() lets go of the protocol and ends the conversation once, however often it is called', async () => {
  const agent = peer(() => undefined);
  const channel = acpTransportOver(agent.conversation);
  await Promise.all([channel.stop(), channel.stop()]);
  await channel.stop();
  assert.equal(agent.stops(), 1);
  assert.equal(channel.transport.alive, false);
});
