import assert from 'node:assert/strict';
import test from 'node:test';
import { handOverToService } from './desktop';

/** The bridge the desktop shell exposes, or none (a browser). */
async function withBridge<T>(bridge: Record<string, unknown> | null, run: () => Promise<T>): Promise<T> {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    value: bridge ? { novaDesktop: { restartAfterSetup: async () => {}, ...bridge } } : {},
    configurable: true, writable: true,
  });
  try { return await run(); } finally {
    if (saved) Object.defineProperty(globalThis, 'window', saved);
    else delete (globalThis as Record<string, unknown>).window;
  }
}

test('the shell that hands over keeps the window: the page must not navigate', async () => {
  const asked: unknown[] = [];
  const handOverToServiceBridge = async (route: unknown) => { asked.push(route); return 'handed-over'; };
  assert.equal(await withBridge({ handOverToService: handOverToServiceBridge }, () => handOverToService('/setup/agent')), true);
  assert.deepEqual(asked, ['/setup/agent']);
  // The service did not answer: the shell gave the place back to its embedded daemon and reopened the route itself.
  assert.equal(await withBridge({ handOverToService: async () => 'kept-embedded' }, () => handOverToService('/')), true);
});

test('with nothing to hand over, the page goes on by itself', async () => {
  // A browser on the daemon, a portable install, an older shell, a refused call.
  assert.equal(await withBridge(null, () => handOverToService('/setup/agent')), false);
  assert.equal(await withBridge({}, () => handOverToService('/setup/agent')), false);
  assert.equal(await withBridge({ handOverToService: async () => 'not-needed' }, () => handOverToService('/setup/agent')), false);
  assert.equal(await withBridge({ handOverToService: async () => { throw new Error('refused'); } }, () => handOverToService('/')), false);
});
