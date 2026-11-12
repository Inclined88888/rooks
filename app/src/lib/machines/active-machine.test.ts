/**
 * What the root layout decides about the active machine before rendering:
 * local costs nothing, a remote one is probed, and a machine that cannot be
 * used is blocked with its reason — never rendered as a cockpit.
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import type { ActingAccount } from './acting-account';
import type { RenderRead } from './active-machine';
import type { RemoteTarget, Target, UnavailableTarget } from './target';

(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;
process.env.ORCHESTRATOR_URL ??= 'http://127.0.0.1:9';

const remote: RemoteTarget = { kind: 'remote', id: 'vps', url: 'https://vps.example', timeoutMs: 8_000, deviceToken: async () => 'tdev_x' };

const fleet = {
  machines: [{
    id: 'vps', name: 'VPS', api_level: 1,
    remote_user: { email: 'alice@vps', name: 'Alice', is_superadmin: true },
  }],
};

function reader(answers: { caps?: () => Response; fleet?: () => Response }): { read: RenderRead; calls: { path: string; target: string }[] } {
  const calls: { path: string; target: string }[] = [];
  const read: RenderRead = async (path, target: Target) => {
    calls.push({ path, target: target.kind });
    if (path === '/api/capabilities') return (answers.caps ?? (() => Response.json({ apiLevel: 1 })))();
    if (path === '/api/machines') return (answers.fleet ?? (() => Response.json(fleet)))();
    throw new Error(`unexpected ${path}`);
  };
  return { read, calls };
}

const acting: ActingAccount = {
  machine: 'vps',
  user: { id: 'u-remote', email: 'alice@vps', name: 'Alice', is_superadmin: true, avatar_url: null },
  can: null,
};

async function describe(target: Target, answers: Parameters<typeof reader>[0] = {}, account: ActingAccount = acting) {
  const { describeActiveMachine } = await import('./active-machine');
  const { read, calls } = reader(answers);
  const asked: string[] = [];
  const machine = await describeActiveMachine(target, read, async (t) => { asked.push(t.id); return account; });
  return { machine, calls, asked };
}

test('the local machine costs no call', async () => {
  const { describeActiveMachine } = await import('./active-machine');
  const { read, calls } = reader({});
  const asked: string[] = [];
  const machine = await describeActiveMachine({ kind: 'local', id: 'local', url: 'http://127.0.0.1:3001', timeoutMs: 2_000 }, read, async (t) => { asked.push(t.id); return acting; });
  assert.deepEqual(machine, { kind: 'local' });
  assert.equal(calls.length, 0);
  assert.equal(asked.length, 0);
});

test('a reachable remote: its name and the account this computer acts as, from the LOCAL fleet', async () => {
  const { machine, calls, asked } = await describe(remote);
  assert.deepEqual(machine, {
    kind: 'remote', id: 'vps', name: 'VPS', apiLevel: 1, verdict: 'ok',
    account: { email: 'alice@vps', name: 'Alice', isSuperadmin: true },
    acting,
  });
  assert.deepEqual(asked, ['vps']);
  assert.deepEqual(calls.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: '/api/capabilities', target: 'remote' },
    { path: '/api/machines', target: 'local' },
  ]);
});

test('unreachable, revoked or failing: blocked, with the reason', async () => {
  for (const [caps, reason] of [
    [() => Response.json({ error: 'machine_unreachable' }, { status: 502 }), 'unreachable'],
    [() => Response.json({ error: 'boom' }, { status: 500 }), 'unreachable'],
    [() => { throw new Error('timeout'); }, 'unreachable'],
    [() => Response.json({ error: 'unauthorized' }, { status: 401 }), 'unauthorized'],
  ] as const) {
    const { machine } = await describe(remote, { caps });
    assert.equal(machine.kind, 'blocked');
    assert.equal(machine.kind === 'blocked' && machine.reason, reason);
    assert.equal(machine.kind === 'blocked' && machine.name, 'VPS');
  }
});

test('apiLevel: below the minimum blocks; newer or absent is let through with its verdict', async () => {
  const old = await describe(remote, { caps: () => Response.json({ apiLevel: 0 }) });
  assert.deepEqual(old.machine, { kind: 'blocked', id: 'vps', name: 'VPS', reason: 'incompatible', apiLevel: 0 });
  const newer = await describe(remote, { caps: () => Response.json({ apiLevel: 99 }) });
  assert.equal(newer.machine.kind === 'remote' && newer.machine.verdict, 'newer');
  const silent = await describe(remote, { caps: () => Response.json({ version: '0.1.0' }) });
  assert.equal(silent.machine.kind === 'remote' && silent.machine.verdict, 'unknown');
});

test('a licence-locked remote is not blocked here: the lock screen takes over, with the recorded level', async () => {
  const { machine } = await describe(remote, { caps: () => Response.json({ error: 'beta_ended' }, { status: 403 }) });
  assert.equal(machine.kind, 'remote');
  assert.equal(machine.kind === 'remote' && machine.verdict, 'ok');
  const old = await describe(remote, {
    caps: () => Response.json({}, { status: 403 }),
    fleet: () => Response.json({ machines: [{ ...fleet.machines[0], api_level: 0 }] }),
  });
  assert.equal(old.machine.kind === 'blocked' && old.machine.reason, 'incompatible');
});

test('an unavailable target is blocked with its failure; no fleet read without a session', async () => {
  const unknown: UnavailableTarget = { kind: 'unavailable', id: 'gone', failure: 'unknown', timeoutMs: 2_000 };
  const a = await describe(unknown);
  assert.deepEqual(a.machine, { kind: 'blocked', id: 'gone', name: null, reason: 'unknown', apiLevel: null });
  assert.deepEqual(a.calls, [{ path: '/api/machines', target: 'local' }]);
  const noSession = await describe({ ...unknown, id: 'vps', failure: 'session_required' });
  // No local session: not a block, the login page has to render.
  assert.deepEqual(noSession.machine, { kind: 'signed_out', id: 'vps' });
  assert.equal(noSession.calls.length, 0);
  const vault = await describe({ ...unknown, id: 'vps', failure: 'unavailable' });
  assert.equal(vault.machine.kind === 'blocked' && vault.machine.name, 'VPS');
});

test('a fleet the local daemon cannot list leaves the name unknown, nothing worse', async () => {
  const { machine } = await describe(remote, { fleet: () => Response.json({}, { status: 500 }) });
  assert.equal(machine.kind, 'remote');
  assert.equal(machine.kind === 'remote' && machine.name, null);
  assert.equal(machine.kind === 'remote' && machine.account, null);
});

test('layout owner of the server render: local here, the acting account on a remote, nobody otherwise', async () => {
  const { workspaceOwner } = await import('./active-machine');
  const { machine } = await describe(remote);
  assert.equal(workspaceOwner('u-local', { kind: 'local' }), 'u-local');
  assert.equal(workspaceOwner('u-local', machine), 'u-remote');
  // No local session: the remote's answer is not a session.
  assert.equal(workspaceOwner(null, machine), null);
  // A remote that did not say who the device is: no scope at all, never the local id.
  const silent = await describe(remote, {}, { machine: 'vps', user: null, can: null });
  assert.equal(workspaceOwner('u-local', silent.machine), null);
  assert.equal(workspaceOwner('u-local', { kind: 'blocked', id: 'vps', name: null, reason: 'unreachable', apiLevel: null }), null);
  assert.equal(workspaceOwner('u-local', { kind: 'signed_out', id: 'vps' }), null);
});

test('SSR without a flash: the scheme is the machine\'s the page is rendered for', async () => {
  const { activeScheme } = await import('./active-machine');
  assert.equal(activeScheme('dark', { kind: 'local' }), 'dark');
  const { machine } = await describe(remote, {}, { ...acting, scheme: 'light' });
  assert.equal(activeScheme('dark', machine), 'light');
  // That machine did not say: this computer's mode stands in.
  const { machine: silent } = await describe(remote, {}, acting);
  assert.equal(activeScheme('dark', silent), 'dark');
  // A blocked machine's screen belongs to this computer.
  const { machine: blocked } = await describe(remote, { caps: () => { throw new Error('ECONNREFUSED'); } }, { ...acting, scheme: 'light' });
  assert.equal(blocked.kind, 'blocked');
  assert.equal(activeScheme('dark', blocked), 'dark');
});
