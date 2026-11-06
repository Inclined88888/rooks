/**
 * `/api/ui/auth/me` with a remote machine active: the local answer proves the
 * session, the remote is asked who the device is there (TODO #646).
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import type { ActingAccount } from './acting-account';
import type { ActingRead } from './acting-me';
import type { RemoteTarget, Target } from './target';

(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;
process.env.ORCHESTRATOR_URL ??= 'http://127.0.0.1:9';

const remote: RemoteTarget = { kind: 'remote', id: 'vps', url: 'https://vps.example', timeoutMs: 8_000, deviceToken: async () => 'tdev_x' };
const local: Target = { kind: 'local', id: 'local', url: 'http://127.0.0.1:3001', timeoutMs: 2_000 };
const acting: ActingAccount = {
  machine: 'vps',
  user: { id: 'u-remote', email: 'alice@vps', name: 'Alice', is_superadmin: false, avatar_url: null },
  can: { 'projects:manage': false },
};

function reader(answer: ActingAccount = acting): { read: ActingRead; calls: string[] } {
  const calls: string[] = [];
  return { read: async (target) => { calls.push(target.id); return answer; }, calls };
}

const me = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), {
  status: 200, ...init, headers: { 'content-type': 'application/json', 'set-cookie': 'timon_session=renewed; HttpOnly', ...init.headers },
});

test('an anonymous caller makes the remote ask nothing, and gets the local answer untouched', async () => {
  const { withActingAccount } = await import('./acting-me');
  for (const res of [
    me({ error: 'unauthorized' }, { status: 401 }),
    me({ user: null, needsSetup: false }),
    new Response('not json', { status: 200 }),
  ]) {
    const { read, calls } = reader();
    const out = await withActingAccount(res, remote, read);
    assert.equal(calls.length, 0);
    const text = await out.text();
    assert.ok(!text.includes('acting'), text);
    assert.ok(!text.includes('u-remote'), text);
  }
});

test('the local machine: no remote read, the answer passes as is', async () => {
  const { withActingAccount } = await import('./acting-me');
  const { read, calls } = reader();
  const res = me({ user: { id: 'u-local' } });
  assert.equal(await withActingAccount(res, local, read), res);
  assert.equal(calls.length, 0);
});

test('a remote machine: the acting account is added, the local session and its cookie kept', async () => {
  const { withActingAccount } = await import('./acting-me');
  const { read, calls } = reader();
  const out = await withActingAccount(me({ user: { id: 'u-local', name: 'Local' }, can: { 'projects:manage': true } }), remote, read);
  assert.deepEqual(calls, ['vps']);
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') ?? '', /timon_session=renewed/);
  const body = await out.json() as { user: { id: string }; acting: ActingAccount };
  assert.equal(body.user.id, 'u-local');
  assert.deepEqual(body.acting, acting);
});

test('a machine the relay cannot reach (forged or foreign id): named, with no account, and never asked', async () => {
  const { withActingAccount } = await import('./acting-me');
  const { read, calls } = reader();
  const out = await withActingAccount(me({ user: { id: 'u-local' } }), { kind: 'unavailable', id: 'other', failure: 'unknown', timeoutMs: 2_000 }, read);
  assert.equal(calls.length, 0);
  assert.deepEqual((await out.json() as { acting: unknown }).acting, { machine: 'other', user: null, can: null });
});

test('the read itself: a refusal, a failure or a body without an account is no account — never a guess', async () => {
  const { readActingAccount } = await import('./acting-me');
  const realFetch = globalThis.fetch;
  const answers: Array<() => Response> = [
    () => Response.json({ error: 'unauthorized' }, { status: 401 }),
    () => { throw new Error('ECONNREFUSED'); },
    () => Response.json({ user: null }),
    () => Response.json({ user: { id: 'u-remote', name: 'Alice', email: 'a@vps', is_superadmin: true }, can: { 'agents:privileged-config': true } }),
  ];
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return answers.shift()!();
  }) as typeof fetch;
  try {
    for (let i = 0; i < 3; i += 1) assert.deepEqual(await readActingAccount(remote), { machine: 'vps', user: null, can: null });
    assert.deepEqual(await readActingAccount(remote), {
      machine: 'vps',
      user: { id: 'u-remote', email: 'a@vps', name: 'Alice', is_superadmin: true, avatar_url: null },
      can: { 'agents:privileged-config': true },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(asked, Array(4).fill('https://vps.example/api/auth/me'));
});

test('the read carries the mode that machine keeps for the device\'s account, and none without an account', async () => {
  const { readActingAccount } = await import('./acting-me');
  const realFetch = globalThis.fetch;
  const answers: Array<() => Response> = [
    () => Response.json({ user: { id: 'u-remote' }, can: null, prefs: { scheme: 'light' } }),
    () => Response.json({ user: { id: 'u-remote' }, prefs: { scheme: 'sepia' } }),
    () => Response.json({ user: null, prefs: { scheme: 'light' } }),
  ];
  globalThis.fetch = (async () => answers.shift()!()) as typeof fetch;
  try {
    assert.equal((await readActingAccount(remote)).scheme, 'light');
    assert.equal('scheme' in await readActingAccount(remote), false);
    assert.equal('scheme' in await readActingAccount(remote), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/ui/auth/me on a remote machine: the local prefs stay, the remote mode travels in the acting block', async () => {
  const { withActingAccount } = await import('./acting-me');
  const { schemeOfMe } = await import('./acting-account');
  const { read } = reader({ ...acting, scheme: 'light' });
  const out = await withActingAccount(me({ user: { id: 'u-local' }, prefs: { scheme: 'dark' } }), remote, read);
  const body = await out.json() as { prefs: { scheme: string } };
  assert.equal(body.prefs.scheme, 'dark');
  assert.equal(schemeOfMe(body), 'light');
});
