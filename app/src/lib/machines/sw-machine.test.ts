/**
 * The service worker answers a notification for the machine that posted it
 * (P4b): Approve/Deny name it in `X-Timon-Machine`, a click switches the
 * interface onto it before opening the card. `public/sw.js` is a static file;
 * it runs here in a `vm` context with the few worker globals it touches.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SW = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://app.test';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Listener = (event: Record<string, unknown>) => void;

function worker(answer: (call: Call) => { status: number; body?: unknown } = () => ({ status: 200 })) {
  const listeners = new Map<string, Listener>();
  const calls: Call[] = [];
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const navigated: string[] = [];
  const opened: string[] = [];
  const client = {
    url: `${ORIGIN}/chat`,
    navigate: async (url: string) => { navigated.push(url); return { focus: async () => undefined }; },
    focus: async () => undefined,
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => { listeners.set(type, fn); },
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); },
      getNotifications: async () => [],
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [client],
      openWindow: async (url: string) => { opened.push(url); },
    },
  };
  const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}) => {
    if (url === '/api/ui/machines/active') assert.ok(init.signal, 'a switch is bounded in time');
    if (url === '/manifest.webmanifest') return { ok: true, json: async () => ({ short_name: 'Timon', icons: [{ src: '/icon.png' }] }) };
    const call: Call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const { status, body } = answer(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body ?? {} };
  };
  // The ack's 6 s fade fires at once: nothing here waits on a clock.
  vm.runInNewContext(SW, { self, fetch, URL, JSON, Promise, AbortSignal, setTimeout: (fn: () => void) => { fn(); return 0; }, console });

  async function dispatch(type: string, event: Record<string, unknown>): Promise<void> {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending;
  }
  return {
    calls, shown, navigated, opened,
    push: (data: unknown) => dispatch('push', { data: { json: () => data } }),
    click: (data: Record<string, unknown>, action = '') => dispatch('notificationclick', { action, notification: { data, close: () => undefined } }),
  };
}

const card = { kind: 'notification', id: 'n1', title: 'VPS · Bash?', tag: 'timon-anchor-machine:vps:r1', url: null, urgent: true, permissionId: 'remote-perm', machineId: 'vps' };

test('a relayed card keeps its machine on the notification', async () => {
  const sw = worker();
  await sw.push(card);
  assert.equal(sw.shown[0]?.options.data && (sw.shown[0].options.data as { machineId: unknown }).machineId, 'vps');
});

test('Approve answers on the machine of the card, with the remote permission id', async () => {
  const sw = worker();
  await sw.click({ permissionId: 'remote-perm', machineId: 'vps', tag: card.tag, url: '/notifications' }, 'allow');
  const [call] = sw.calls;
  assert.equal(call?.url, '/api/ui/permissions/remote-perm/resolve');
  assert.equal(call?.headers['x-timon-machine'], 'vps');
  assert.deepEqual(call?.body, { behavior: 'allow', origin: 'push_action' });
});

test('a card of this computer is answered here, whatever the active machine', async () => {
  const sw = worker();
  await sw.click({ permissionId: 'p1', machineId: null, tag: 't', url: '/chat?mission=m1' }, 'deny');
  assert.equal(sw.calls[0]?.headers['x-timon-machine'], 'local');
  // A malformed id from the payload is never sent as is.
  const odd = worker();
  await odd.click({ permissionId: 'p1', machineId: '../x', tag: 't' }, 'allow');
  assert.equal(odd.calls[0]?.headers['x-timon-machine'], 'local');
});

test('a click switches onto the machine of the card, then opens it', async () => {
  const sw = worker();
  await sw.click({ machineId: 'vps', url: '/notifications' });
  assert.deepEqual(sw.calls.map((c) => [c.method, c.url, c.body]), [['POST', '/api/ui/machines/active', { id: 'vps' }]]);
  assert.deepEqual(sw.navigated, [`${ORIGIN}/notifications`]);
});

test('a click on a card of this computer brings the interface back here', async () => {
  const sw = worker();
  await sw.click({ machineId: null, url: '/chat?mission=m1' });
  assert.deepEqual(sw.calls.map((c) => c.body), [{ id: 'local' }]);
  assert.deepEqual(sw.navigated, [`${ORIGIN}/chat?mission=m1`]);
});

test('a machine that cannot be switched to falls back to this computer’s copy of the card', async () => {
  const sw = worker((call) => ((call.body as { id?: string } | null)?.id === 'vps' ? { status: 502, body: { error: 'machine_unreachable' } } : { status: 200 }));
  await sw.click({ machineId: 'vps', url: '/notifications' });
  assert.deepEqual(sw.calls.map((c) => c.body), [{ id: 'vps' }, { id: 'local' }]);
  assert.deepEqual(sw.navigated, [`${ORIGIN}/notifications`]);
});

test('an answer the network lost opens the card on its machine', async () => {
  let first = true;
  const sw = worker((call) => {
    if (first && call.url.includes('/permissions/')) { first = false; throw new Error('offline'); }
    return { status: 200 };
  });
  await sw.click({ permissionId: 'remote-perm', machineId: 'vps', tag: 't', url: '/notifications' }, 'allow');
  assert.deepEqual(sw.calls.map((c) => c.url), ['/api/ui/permissions/remote-perm/resolve', '/api/ui/machines/active']);
  assert.deepEqual(sw.calls[1]?.body, { id: 'vps' });
  assert.deepEqual(sw.navigated, [`${ORIGIN}/notifications`]);
});
