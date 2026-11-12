import assert from 'node:assert/strict';
import test from 'node:test';
import { reportWindowScheme } from './window-scheme';
import { MACHINE_ATTRIBUTE } from './machines/machine-storage';

type Globals = { document?: unknown; window?: unknown };
const g = globalThis as unknown as Globals;

function page(machine: string | undefined, bridge?: (request: unknown) => Promise<unknown>) {
  g.document = { documentElement: { getAttribute: (name: string) => (name === MACHINE_ATTRIBUTE ? machine ?? null : null) } };
  g.window = bridge ? { novaDesktop: { windowScheme: bridge } } : {};
}

test.afterEach(() => {
  delete g.document;
  delete g.window;
});

test('each machine its mode: the page tells the shell its mode and the machine it was served for', () => {
  const asked: unknown[] = [];
  page('vps', async (request) => { asked.push(request); });
  reportWindowScheme('light');
  page(undefined, async (request) => { asked.push(request); });
  reportWindowScheme('dark');
  assert.deepEqual(asked, [{ scheme: 'light', machineId: 'vps' }, { scheme: 'dark', machineId: 'local' }]);
});

test('each machine its mode: the web, the PWA and an older or failing shell are left alone', async () => {
  page('vps');
  reportWindowScheme('light');
  page('vps', async () => { throw new Error("No handler registered for 'rooks:window-scheme'"); });
  reportWindowScheme('light');
  page('vps', () => { throw new Error('sync'); });
  reportWindowScheme('light');
  await new Promise((resolve) => setImmediate(resolve));
});
