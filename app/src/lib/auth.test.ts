import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actingUser,
  fetchMe,
  meCan,
  readAuthMe,
  pageRequiresLogin,
  shouldRedirectOn401,
} from './auth';

test('authentication rejects empty, truncated and HTML responses with safe context', async () => {
  const original = globalThis.fetch;
  const warn = console.warn;
  const logs: string[] = [];
  console.warn = (message: string) => { logs.push(message); };
  try {
    for (const response of [
      new Response(null, { status: 204 }),
      new Response('{"secret":"private', { headers: { 'content-type': 'application/json' } }),
      new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }),
      Response.json(null),
    ]) {
      globalThis.fetch = async () => response;
      await assert.rejects(fetchMe(), /\[TIM-0011\] \/api\/ui\/auth\/me:/);
    }
    assert.equal(logs.length, 4);
    assert.ok(logs.every((line) => !line.includes('private')));
    globalThis.fetch = async () => Response.json({ user: null, needsSetup: true });
    assert.equal((await fetchMe()).needsSetup, true);
    globalThis.fetch = async () => new Response('{"needsSetup":true}');
    assert.equal((await fetchMe()).needsSetup, true);
    globalThis.fetch = async () => new Response(null, { status: 401 });
    assert.equal((await fetchMe()).needsSetup, false);
    // Daemon still warming must keep first-run on create + Skip.
    globalThis.fetch = async () => new Response(null, { status: 503 });
    assert.equal((await fetchMe()).needsSetup, true);
  } finally { globalThis.fetch = original; console.warn = warn; }
});

test('pages without a session go to login; /login, /invite and /api do not', () => {
  assert.equal(pageRequiresLogin('/'), true);
  assert.equal(pageRequiresLogin('/agents'), true);
  assert.equal(pageRequiresLogin('/login'), false);
  assert.equal(pageRequiresLogin('/login/'), false);
  assert.equal(pageRequiresLogin('/invite'), false);
  assert.equal(pageRequiresLogin('/invite/'), false);
  assert.equal(pageRequiresLogin('/api/ui/stats'), false);
  assert.equal(pageRequiresLogin('/_next/static/chunk.js'), false);
});

test('a 401 from the UI proxy sends the browser to login, except auth endpoints', () => {
  assert.equal(shouldRedirectOn401('/', '/api/ui/stats'), true);
  assert.equal(shouldRedirectOn401('/agents', '/api/ui/missions'), true);
  assert.equal(shouldRedirectOn401('/', '/api/ui/auth/login'), false);
  assert.equal(shouldRedirectOn401('/', '/api/ui/auth/me'), false);
  assert.equal(shouldRedirectOn401('/login', '/api/ui/stats'), false);
  assert.equal(shouldRedirectOn401('/invite', '/api/ui/plugins/multi-user/invite/x'), false);
  assert.equal(shouldRedirectOn401('/', '/api/channels/x/inbound'), false);
});

test('meCan reads the daemon answer and stays closed while unknown (TODO #560)', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ user: null, can: { 'projects:manage': false, 'other:perm': true } });
    const denied = await fetchMe();
    assert.deepEqual(denied.can, { 'projects:manage': false });
    assert.equal(meCan(denied, 'projects:manage'), false);

    globalThis.fetch = async () => Response.json({ user: null, can: { 'projects:manage': true } });
    assert.equal(meCan(await fetchMe(), 'projects:manage'), true);

    // TODO #620: the skill attachment controls read their own grant, apart.
    globalThis.fetch = async () => Response.json({ user: null, can: { 'projects:manage': true, 'agents:privileged-config': false } });
    const split = await fetchMe();
    assert.equal(meCan(split, 'projects:manage'), true);
    assert.equal(meCan(split, 'agents:privileged-config'), false);
    globalThis.fetch = async () => Response.json({ user: null, can: { 'projects:manage': false, 'agents:privileged-config': true } });
    assert.equal(meCan(await fetchMe(), 'agents:privileged-config'), true);

    // A non-boolean is not a grant.
    globalThis.fetch = async () => Response.json({ user: null, can: { 'projects:manage': 'yes' } });
    assert.equal(meCan(await fetchMe(), 'projects:manage'), false);

    // A failed read is not a grant either.
    globalThis.fetch = async () => new Response(null, { status: 401 });
    assert.equal(meCan(await fetchMe(), 'projects:manage'), false);

    // A daemon older than the field leaves the decision to its route.
    globalThis.fetch = async () => Response.json({ user: null, needsSetup: false });
    assert.equal(meCan(await fetchMe(), 'projects:manage'), true);

    assert.equal(meCan(null, 'projects:manage'), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('on a remote machine, permissions and "is it mine" are the acting account\'s; the session stays local (TODO #646)', () => {
  const localUser = { id: 'u-local', email: 'me@here', name: 'Me', status: 'active', is_superadmin: true, created_at: 0, last_login_at: null, avatar_url: null };
  const remoteUser = { id: 'u-remote', email: 'me@vps', name: 'Me there', is_superadmin: false, avatar_url: null };

  const here = readAuthMe({ user: localUser, can: { 'projects:manage': true } });
  assert.equal(here.acting, null);
  assert.equal(actingUser(here)?.id, 'u-local');
  assert.equal(meCan(here, 'projects:manage'), true);

  // A local superadmin acting as a restricted account there: refused there,
  // so greyed here — and not an admin of that machine.
  const there = readAuthMe({ user: localUser, can: { 'projects:manage': true }, acting: { machine: 'vps', user: remoteUser, can: { 'projects:manage': false } } });
  assert.equal(there.user?.id, 'u-local');
  assert.equal(actingUser(there)?.id, 'u-remote');
  assert.equal(actingUser(there)?.is_superadmin, false);
  assert.equal(meCan(there, 'projects:manage'), false);

  // That machine could not say who the device is: no account, no grant.
  const unknown = readAuthMe({ user: localUser, can: { 'projects:manage': true }, acting: { machine: 'vps', user: null, can: null } });
  assert.equal(actingUser(unknown), null);
  assert.equal(meCan(unknown, 'projects:manage'), false);

  // A remote daemon older than `can`: its route decides, as for a local one.
  const older = readAuthMe({ user: localUser, acting: { machine: 'vps', user: remoteUser } });
  assert.equal(meCan(older, 'projects:manage'), true);
});
