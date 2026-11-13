import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;

type TargetModule = typeof import('./target');
type CredentialModule = typeof import('./credential');
/** The daemon's own verifier: the relay and the daemon must agree on it. */
interface DaemonProof {
  verifyRelayProof(value: string | string[] | undefined, daemonToken: string, machineId: string, nowMs?: number): boolean;
  carriesBrowserMetadata(headers: IncomingMessage['headers']): boolean;
}

interface Seen { method: string; url: string; headers: IncomingMessage['headers'] }
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** The remote machine. */
const seen: Seen[] = [];
let handler: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
};
const server = createServer((req, res) => {
  seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
  handler(req, res);
});

/** The local daemon: the fleet's `/credential`, and anything relayed locally. */
const daemonSeen: Seen[] = [];
let daemonHandler: Handler = () => {};
const daemon = createServer((req, res) => {
  daemonSeen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
  daemonHandler(req, res);
});

let mod!: TargetModule;
let cred!: CredentialModule;
let proof!: DaemonProof;
let base = '';
let daemonBase = '';
let home = '';
const DAEMON_TOKEN = 'daemon-token-must-never-leave';
const SESSION = 'local-session-of-alice';
const DEVICE_TOKEN = 'tdev_device-token-of-alice-for-vps';

function listen(s: Server): Promise<string> {
  return new Promise((done) => s.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}

/** What the real daemon answers (`orchestrator/src/machines/http.ts`): the
 *  proof first, then the session, then the owner's row. */
function fleetDaemon(machines: Record<string, string> = { vps: '' }): Handler {
  return (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const m = /^\/api\/machines\/([^/]+)\/credential$/.exec(req.url ?? '');
    if (!m) return json(200, { local: true });
    const id = decodeURIComponent(m[1]!);
    if (req.headers.cookie !== `rooks_session=${SESSION}`) return json(401, { error: 'unauthorized' });
    if (proof.carriesBrowserMetadata(req.headers) || !proof.verifyRelayProof(req.headers['x-rooks-relay-proof'], DAEMON_TOKEN, id)) {
      return json(403, { error: 'forbidden' });
    }
    if (!(id in machines)) return json(404, { error: 'machine not found' });
    json(200, { id, url: machines[id] || base, token: DEVICE_TOKEN, version: '0.1.5', api_level: 1 });
  };
}

test.before(async () => {
  base = await listen(server);
  daemonBase = await listen(daemon);
  // `paths.ts` reads the daemon's address and the home once, at import: the
  // proof's key comes from this home, never from the real one.
  home = mkdtempSync(join(tmpdir(), 'rooks-target-'));
  writeFileSync(join(home, 'daemon-token'), `${DAEMON_TOKEN}\n`);
  process.env.ROOKS_HOME = home;
  process.env.ORCHESTRATOR_URL = daemonBase;
  process.env.ROOKS_DAEMON_TOKEN = DAEMON_TOKEN;
  mod = await import('./target');
  cred = await import('./credential');
  proof = await import(new URL('../../../../orchestrator/src/machines/relay-proof.ts', import.meta.url).href) as DaemonProof;
});

test.after(() => {
  for (const s of [server, daemon]) {
    s.closeAllConnections();
    s.close();
  }
  rmSync(home, { recursive: true, force: true });
});

test.beforeEach(() => {
  seen.length = 0;
  daemonSeen.length = 0;
  cred.forgetMachineCredentials();
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  };
  daemonHandler = fleetDaemon();
});

function remote(url = base): import('./target').RemoteTarget {
  return { kind: 'remote', id: 'vps', url, timeoutMs: 8_000, deviceToken: async () => 'device-token-1' };
}

const browser = (init: Record<string, string>) => new Headers(init);
const page = (cookie: string, extra: Record<string, string> = {}) => new Request('http://app.test/', { headers: { cookie, ...extra } });
const credentialCalls = () => daemonSeen.filter((s) => s.url.includes('/credential'));

// ---- resolution ----------------------------------------------------------

test('the local target is the daemon this app belongs to', () => {
  const t = mod.localTarget();
  assert.equal(t.kind, 'local');
  assert.equal(t.id, mod.LOCAL_MACHINE_ID);
  assert.equal(t.url, daemonBase);
});

test('no machine cookie, the local id or a malformed one: the local daemon, nothing asked', async () => {
  assert.deepEqual(await mod.resolveTarget(), mod.localTarget());
  assert.deepEqual(await mod.resolveTarget(page(`rooks_session=${SESSION}`)), mod.localTarget());
  assert.deepEqual(await mod.resolveTarget(page(`rooks_session=${SESSION}; rooks_machine=local`)), mod.localTarget());
  assert.deepEqual(await mod.resolveTarget(page('rooks_machine=https%3A%2F%2Fevil.example')), mod.localTarget());
  assert.equal(daemonSeen.length, 0);
});

test('the machine cookie carries an id, never an URL', () => {
  assert.equal(mod.machineIdFromCookieHeader('a=1; rooks_machine=vps-2 ; b=2'), 'vps-2');
  assert.equal(mod.machineIdFromCookieHeader('rooks_machine=https%3A%2F%2Fevil.example'), null);
  assert.equal(mod.machineIdFromCookieHeader('rooks_machine=a/b'), null);
  assert.equal(mod.machineIdFromCookieHeader('rooks_machine=%E0%A4%A'), null);
  assert.equal(mod.machineIdFromCookieHeader('x_rooks_machine=vps'), null);
  assert.equal(mod.machineIdFromCookieHeader(''), null);
  assert.equal(mod.machineIdFromCookieHeader(null), null);
});

test('a machine of this person resolves to its URL and device token, given by the local daemon', async () => {
  const t = await mod.resolveTarget(page(`other=1; rooks_session=${SESSION}; rooks_machine=vps`));
  assert.equal(t.kind, 'remote');
  if (t.kind !== 'remote') return;
  assert.equal(t.id, 'vps');
  assert.equal(t.url, base);
  assert.equal(await t.deviceToken(), DEVICE_TOKEN);
  assert.equal(credentialCalls().length, 1);
  assert.equal(credentialCalls()[0]?.url, '/api/machines/vps/credential');
});

test('the credential call: the local session and the proof only — no browser header, never the daemon token', async () => {
  // Everything a browser sends, on the page request the relay serves.
  await mod.resolveTarget(page(`rooks_session=${SESSION}; rooks_machine=vps; tracker=x`, {
    origin: 'http://app.test', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty', authorization: 'Bearer from-browser', 'x-forwarded-host': 'app.test',
  }));
  const call = credentialCalls()[0];
  assert.ok(call);
  assert.equal(call.headers.cookie, `rooks_session=${SESSION}`);
  for (const name of ['origin', 'sec-fetch-site', 'sec-fetch-dest', 'authorization', 'x-forwarded-host', 'referer']) {
    assert.equal(call.headers[name], undefined, name);
  }
  assert.ok(proof.verifyRelayProof(call.headers['x-rooks-relay-proof'], DAEMON_TOKEN, 'vps'));
  assert.ok(!JSON.stringify(call.headers).includes(DAEMON_TOKEN));
});

test('the proof binds the machine id and the time: another id or a stale one is refused by the daemon', () => {
  const now = Date.now();
  const value = cred.relayProof(DAEMON_TOKEN, 'vps', now);
  assert.ok(proof.verifyRelayProof(value, DAEMON_TOKEN, 'vps', now));
  assert.equal(proof.verifyRelayProof(value, DAEMON_TOKEN, 'nas', now), false);
  assert.equal(proof.verifyRelayProof(value, DAEMON_TOKEN, 'vps', now + 61_000), false);
  assert.equal(proof.verifyRelayProof(value, 'another-daemon', 'vps', now), false);
});

test('forged cookie: an unknown id, or another account\'s machine, is refused — nothing relayed anywhere', async () => {
  // The daemon answers the same 404 for both (owner-filtered).
  for (const id of ['unknown-machine', 'bobs-machine']) {
    const t = await mod.resolveTarget(page(`rooks_session=${SESSION}; rooks_machine=${id}`));
    assert.equal(t.kind, 'unavailable', id);
    const res = await mod.relayFetch(t, '/api/agents', { method: 'DELETE' }, { incoming: browser({ 'sec-fetch-site': 'same-origin' }) });
    assert.equal(res.status, 404, id);
    assert.equal((await res.json() as { error: string }).error, 'machine_unknown', id);
    assert.deepEqual(await mod.upgradeCredential(t, browser({ origin: 'http://app.test', host: 'app.test' }), undefined), { ok: false, status: 404 });
  }
  assert.equal(seen.length, 0);
  // Only the two lookups reached the local daemon: the DELETE did not fall back to it.
  assert.deepEqual(daemonSeen.map((s) => s.method), ['GET', 'GET']);
});

test('without a local session, a remote machine is refused before the daemon is even asked', async () => {
  for (const cookie of ['rooks_machine=vps', 'rooks_session=; rooks_machine=vps']) {
    const t = await mod.resolveTarget(page(cookie));
    assert.equal(t.kind, 'unavailable');
    const res = await mod.relayFetch(t, '/api/agents');
    assert.equal(res.status, 401);
    assert.equal((await res.json() as { error: string }).error, 'machine_session_required');
  }
  assert.equal(daemonSeen.length, 0);
  assert.equal(seen.length, 0);
});

test('a local session the daemon no longer accepts is refused like no session', async () => {
  const t = await mod.resolveTarget(page('rooks_session=revoked; rooks_machine=vps'));
  assert.equal(t.kind, 'unavailable');
  assert.equal((await mod.relayFetch(t, '/api/agents')).status, 401);
  assert.equal(seen.length, 0);
});

test('the daemon unable to hand out the token: a typed 502, never the local daemon in its place', async () => {
  const answers: Handler[] = [
    (_req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"vault_unavailable"}'); },
    (_req, res) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"forbidden"}'); },
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'vps', url: base, token: 'not-a-device-token' })); },
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'other', url: base, token: DEVICE_TOKEN })); },
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>'); },
    (_req, res) => { res.writeHead(302, { location: 'http://evil.example' }); res.end(); },
  ];
  for (const [i, answer] of answers.entries()) {
    cred.forgetMachineCredentials();
    daemonHandler = answer;
    const t = await mod.resolveTarget(page(`rooks_session=${SESSION}; rooks_machine=vps`));
    assert.equal(t.kind, 'unavailable', String(i));
    const res = await mod.relayFetch(t, '/api/agents');
    assert.equal(res.status, 502, String(i));
    assert.equal((await res.json() as { error: string }).error, 'machine_credential_unavailable', String(i));
  }
  assert.equal(seen.length, 0);
});

test('without the daemon token, no proof can be made: refused, and nothing is asked', async () => {
  writeFileSync(join(home, 'daemon-token'), '');
  const saved = process.env.ROOKS_DAEMON_TOKEN;
  delete process.env.ROOKS_DAEMON_TOKEN;
  try {
    const t = await mod.resolveTarget(page(`rooks_session=${SESSION}; rooks_machine=vps`));
    assert.equal(t.kind, 'unavailable');
    assert.equal(daemonSeen.length, 0);
  } finally {
    process.env.ROOKS_DAEMON_TOKEN = saved;
    writeFileSync(join(home, 'daemon-token'), DAEMON_TOKEN);
  }
});

test('the credential is kept a minute at most, per session: another session asks again', async () => {
  const alice = page(`rooks_session=${SESSION}; rooks_machine=vps`);
  await mod.resolveTarget(alice);
  await Promise.all([mod.resolveTarget(alice), mod.resolveTarget(alice)]);
  assert.equal(credentialCalls().length, 1);
  await mod.resolveTarget(page('rooks_session=someone-else; rooks_machine=vps'));
  assert.equal(credentialCalls().length, 2);
  assert.ok(cred.CREDENTIAL_TTL_MS <= 60_000);
  const realNow = Date.now;
  Date.now = () => realNow() + cred.CREDENTIAL_TTL_MS + 1;
  try {
    await mod.resolveTarget(alice);
  } finally {
    Date.now = realNow;
  }
  assert.equal(credentialCalls().length, 3);
});

test('a failed lookup is not kept: the next request asks again', async () => {
  daemonHandler = (_req, res) => { res.writeHead(503); res.end(); };
  const alice = page(`rooks_session=${SESSION}; rooks_machine=vps`);
  assert.equal((await mod.resolveTarget(alice)).kind, 'unavailable');
  daemonHandler = fleetDaemon();
  assert.equal((await mod.resolveTarget(alice)).kind, 'remote');
});

test('an account or fleet change relayed to the local daemon empties the credential cache', async () => {
  const alice = page(`rooks_session=${SESSION}; rooks_machine=vps`);
  await mod.resolveTarget(alice);
  // A read does not.
  await mod.relayFetch(mod.localTarget(), '/api/machines');
  await mod.resolveTarget(alice);
  assert.equal(credentialCalls().length, 1);
  for (const [method, path] of [['POST', '/api/auth/logout'], ['DELETE', '/api/machines/vps'], ['POST', '/api/machines/pair']] as const) {
    await mod.relayFetch(mod.localTarget(), path, { method, body: method === 'DELETE' ? undefined : '{}' });
    await mod.resolveTarget(alice);
  }
  assert.equal(credentialCalls().length, 4);
});

test('a relay through a resolved machine sends its device token, and only that', async () => {
  const t = await mod.resolveTarget(page(`rooks_session=${SESSION}; rooks_machine=vps`));
  await mod.relayFetch(t, '/api/agents', { headers: { cookie: `rooks_session=${SESSION}`, authorization: `Bearer ${DAEMON_TOKEN}` } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.headers.authorization, `Bearer ${DEVICE_TOKEN}`);
  assert.equal(seen[0]?.headers.cookie, undefined);
  assert.ok(!JSON.stringify(seen[0]?.headers).includes(DAEMON_TOKEN));
  assert.ok(!JSON.stringify(seen[0]?.headers).includes(SESSION));
});

// ---- X-Rooks-Machine -------------------------------------------------------

const pinned = (machine: string, cookie: string) => new Request('http://app.test/', { headers: { 'x-rooks-machine': machine, cookie } });

test('the header is read first, then the cookie; blank or absent leaves the cookie in charge', () => {
  const read = (h: Record<string, string>) => mod.machineIdFromRequest(new Headers(h));
  assert.deepEqual(read({ 'x-rooks-machine': 'nas', cookie: 'rooks_machine=vps' }), { kind: 'named', id: 'nas', by: 'header' });
  assert.deepEqual(read({ 'x-rooks-machine': ' nas ' }), { kind: 'named', id: 'nas', by: 'header' });
  assert.deepEqual(read({ cookie: 'rooks_machine=vps' }), { kind: 'named', id: 'vps', by: 'cookie' });
  assert.deepEqual(read({ 'x-rooks-machine': '', cookie: 'rooks_machine=vps' }), { kind: 'named', id: 'vps', by: 'cookie' });
  assert.deepEqual(read({ 'x-rooks-machine': '   ', cookie: 'rooks_machine=vps' }), { kind: 'named', id: 'vps', by: 'cookie' });
  assert.deepEqual(read({}), { kind: 'none' });
  // A malformed cookie is still ignored; a malformed header is not.
  assert.deepEqual(read({ cookie: 'rooks_machine=a/b' }), { kind: 'none' });
  for (const bad of ['https://evil.example', '../vps', 'vps, nas', 'a'.repeat(65), 'vps%2F']) {
    assert.deepEqual(read({ 'x-rooks-machine': bad, cookie: 'rooks_machine=vps' }), { kind: 'malformed' }, bad);
  }
});

test('X-Rooks-Machine wins over the cookie, both ways', async () => {
  const there = await mod.resolveTarget(pinned('vps', `rooks_session=${SESSION}; rooks_machine=local`));
  assert.equal(there.kind, 'remote');
  assert.equal(there.id, 'vps');
  assert.deepEqual(credentialCalls().map((c) => c.url), ['/api/machines/vps/credential']);
  assert.deepEqual(await mod.resolveTarget(pinned('local', `rooks_session=${SESSION}; rooks_machine=vps`)), mod.localTarget());
  assert.equal(credentialCalls().length, 1);
});

test('X-Rooks-Machine naming another account\'s machine, or an unknown one: unavailable, nothing relayed anywhere', async () => {
  for (const id of ['bobs-machine', 'unknown-machine']) {
    const t = await mod.resolveTarget(pinned(id, `rooks_session=${SESSION}; rooks_machine=vps`));
    assert.equal(t.kind, 'unavailable', id);
    assert.equal(t.id, id);
    const res = await mod.relayFetch(t, '/api/agents', { method: 'DELETE' }, { incoming: browser({ 'sec-fetch-site': 'same-origin' }) });
    assert.equal(res.status, 404, id);
    assert.equal((await res.json() as { error: string }).error, 'machine_unknown', id);
  }
  assert.equal(seen.length, 0);
  assert.deepEqual(daemonSeen.map((s) => s.url), ['/api/machines/bobs-machine/credential', '/api/machines/unknown-machine/credential']);
});

test('X-Rooks-Machine without a local session: refused before the daemon is asked', async () => {
  for (const cookie of ['', 'rooks_session=', 'rooks_machine=local']) {
    const t = await mod.resolveTarget(pinned('vps', cookie));
    assert.equal(t.kind, 'unavailable', cookie);
    assert.equal((await mod.relayFetch(t, '/api/agents')).status, 401, cookie);
  }
  assert.equal(daemonSeen.length, 0);
  assert.equal(seen.length, 0);
});

test('a malformed X-Rooks-Machine is unavailable: neither the cookie\'s machine nor local serves it', async () => {
  const t = await mod.resolveTarget(pinned('../vps', `rooks_session=${SESSION}; rooks_machine=vps`));
  assert.equal(t.kind, 'unavailable');
  assert.equal(t.id, mod.MALFORMED_MACHINE_ID);
  assert.equal((await mod.relayFetch(t, '/api/agents', { method: 'DELETE' }, { incoming: browser({ 'sec-fetch-site': 'same-origin' }) })).status, 404);
  assert.equal(daemonSeen.length, 0);
  assert.equal(seen.length, 0);
});

test('X-Rooks-Machine never reaches a remote daemon, and does not loosen the origin check', async () => {
  const t = await mod.resolveTarget(pinned('vps', `rooks_session=${SESSION}`));
  await mod.relayFetch(t, '/api/agents', { headers: { 'x-rooks-machine': 'vps', 'X-Rooks-Machine': 'vps' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.headers['x-rooks-machine'], undefined);
  const refused = await mod.relayFetch(t, '/api/agents', { method: 'POST', body: '{}' }, { incoming: browser({ 'x-rooks-machine': 'vps', 'sec-fetch-site': 'cross-site' }) });
  assert.equal(refused.status, 403);
  const bare = await mod.relayFetch(t, '/api/agents', { method: 'POST', body: '{}' }, { incoming: browser({ 'x-rooks-machine': 'vps' }) });
  assert.equal(bare.status, 403);
  assert.equal(seen.length, 1);
});

test('the account and the fleet stay local even for a request pinned to a remote machine', async () => {
  const onRemote = pinned('vps', `rooks_session=${SESSION}`);
  for (const path of ['/api/auth/me', '/api/machines', '/api/machines/vps/status']) {
    assert.deepEqual(await mod.targetFor(path, onRemote), mod.localTarget(), path);
  }
  assert.equal(credentialCalls().length, 0);
});

// ---- anchored on the local daemon -----------------------------------------

test('the account and the fleet stay on the local daemon whatever the active machine', async () => {
  const onRemote = page(`rooks_session=${SESSION}; rooks_machine=vps`);
  for (const path of ['/api/auth/me', '/api/auth/logout', '/api/machines', '/api/machines/vps', '/api/machines/vps/status', '/API/Machines/pair', '/api/x/../machines']) {
    assert.equal(mod.anchoredLocally(path), true, path);
    assert.deepEqual(await mod.targetFor(path, onRemote), mod.localTarget(), path);
  }
  assert.equal(credentialCalls().length, 0);
  for (const path of ['/api/agents', '/api/machinesx', '/api/license', '/api/stream', '/api/devices']) {
    assert.equal(mod.anchoredLocally(path), false, path);
  }
  assert.equal((await mod.targetFor('/api/agents', onRemote)).kind, 'remote');
});

test('the light/dark mode is written on the active machine, like its primary colour: never on this computer\'s account', async () => {
  const onRemote = page(`rooks_session=${SESSION}; rooks_machine=vps`);
  assert.equal(mod.anchoredLocally('/api/prefs'), false);
  assert.equal((await mod.targetFor('/api/prefs', onRemote)).kind, 'remote');
  assert.equal((await mod.targetFor('/api/layout?scope=ui-appearance', onRemote)).kind, 'remote');
});

// ---- local: unchanged ----------------------------------------------------

test('local relay is a plain pass-through: session cookie sent, Set-Cookie kept', async () => {
  daemonHandler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'rooks_session=new; HttpOnly' });
    res.end('{"ok":true}');
  };
  const res = await mod.relayFetch(mod.localTarget(), '/api/auth/login', {
    method: 'POST', headers: { cookie: 'rooks_session=s1' }, body: '{}',
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie') ?? '', /rooks_session=new/);
  assert.equal(daemonSeen[0]?.headers.cookie, 'rooks_session=s1');
  assert.equal(daemonSeen[0]?.headers.authorization, undefined);
});

// ---- remote policy -------------------------------------------------------

test('remote: only the device token is sent — no local cookie, never the daemon token', async () => {
  await mod.relayFetch(remote(), '/api/agents', {
    headers: { cookie: 'rooks_session=local-session', authorization: `Bearer ${DAEMON_TOKEN}`, accept: 'application/json' },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.headers.cookie, undefined);
  assert.equal(seen[0]?.headers.authorization, 'Bearer device-token-1');
  assert.equal(seen[0]?.headers.accept, 'application/json');
  assert.ok(!JSON.stringify(seen[0]?.headers).includes(DAEMON_TOKEN));
});

test('remote: Set-Cookie from the remote machine never reaches this origin', async () => {
  handler = (_req, res) => {
    res.setHeader('set-cookie', ['rooks_session=remote; HttpOnly', 'other=1']);
    res.writeHead(200, { 'content-type': 'application/json', 'x-kept': 'yes' });
    res.end('{"ok":true}');
  };
  const res = await mod.relayFetch(remote(), '/api/agents');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.deepEqual(res.headers.getSetCookie(), []);
  assert.equal(res.headers.get('x-kept'), 'yes');
  assert.deepEqual(await res.json(), { ok: true });
});

test('remote: account routes are refused before anything is sent', async () => {
  for (const path of [
    '/api/auth/login', '/api/auth/me', '/api/auth', '/API/Auth/logout', '/api//auth/password',
    '/api/x/../auth/setup', '/api/%61uth/accept-invite', '/api%2Fauth/profile', '/api/auth?x=1',
  ]) {
    const res = await mod.relayFetch(remote(), path, { method: 'POST', body: '{}' }, {
      incoming: browser({ 'sec-fetch-site': 'same-origin' }),
    });
    assert.equal(res.status, 403, path);
    assert.equal((await res.json() as { error: string }).error, 'machine_auth_route', path);
  }
  assert.equal(seen.length, 0);
  // A route that merely starts with the same letters is not an auth route.
  await mod.relayFetch(remote(), '/api/authors');
  assert.equal(seen.length, 1);
});

test('remote: the acting account is read with the device token only, its Set-Cookie dropped, and nothing else of /api/auth', async () => {
  handler = (_req, res) => {
    res.setHeader('set-cookie', 'rooks_session=remote; HttpOnly');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ user: { id: 'u-remote' } }));
  };
  const res = await mod.fetchActingAccount(remote());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.method, 'GET');
  assert.equal(seen[0]?.url, '/api/auth/me');
  assert.equal(seen[0]?.headers.authorization, 'Bearer device-token-1');
  assert.equal(seen[0]?.headers.cookie, undefined);
  // The generic relay still refuses the very same path: the exception is
  // that one fixed read, never a door for what a browser asks.
  const relayed = await mod.relayFetch(remote(), '/api/auth/me', {}, { incoming: browser({ 'sec-fetch-site': 'same-origin' }) });
  assert.equal(relayed.status, 403);
  assert.equal(seen.length, 1);
});

test('remote: the acting account read keeps the transport policy (HTTPS off loopback)', async () => {
  const res = await mod.fetchActingAccount(remote('http://vps.example'));
  assert.equal(res.status, 502);
  assert.equal((await res.json() as { error: string }).error, 'machine_insecure');
  assert.equal(seen.length, 0);
});

test('remote: a mutation without the browser headers is refused', async () => {
  const res = await mod.relayFetch(remote(), '/api/agents', { method: 'POST', body: '{}' });
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { error: string }).error, 'cross_origin');
  assert.equal(seen.length, 0);
});

test('remote: a cross-site mutation is refused by the relay itself', async () => {
  for (const incoming of [
    browser({ 'sec-fetch-site': 'cross-site' }),
    browser({ 'sec-fetch-site': 'same-site', origin: 'https://rooks.localhost', host: 'rooks.localhost' }),
    browser({ 'sec-fetch-site': 'none' }),
    browser({ origin: 'https://evil.example', host: 'rooks.localhost' }),
    browser({ origin: 'null', host: 'rooks.localhost' }),
    browser({ origin: 'https://rooks.localhost' }),
  ]) {
    const res = await mod.relayFetch(remote(), '/api/agents', { method: 'DELETE' }, { incoming });
    assert.equal(res.status, 403);
  }
  assert.equal(seen.length, 0);
});

test('remote: a mutation that carries neither Sec-Fetch-Site nor Origin is refused', async () => {
  // The local rule (`foreignMutation`) lets such a bare client through; the
  // relay to another machine does not.
  for (const incoming of [browser({}), browser({ host: 'rooks.localhost', referer: 'https://rooks.localhost/' })]) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await mod.relayFetch(remote(), '/api/agents', { method, body: method === 'DELETE' ? undefined : '{}' }, { incoming });
      assert.equal(res.status, 403, method);
      assert.equal((await res.json() as { error: string }).error, 'cross_origin', method);
    }
  }
  assert.equal(seen.length, 0);
});

test('remote: an Origin naming the host the browser reached proves same-origin', async () => {
  for (const incoming of [
    browser({ origin: 'https://rooks.localhost', host: 'rooks.localhost' }),
    browser({ origin: 'https://PC.tailnet.ts.net', host: '127.0.0.1:3100', 'x-forwarded-host': 'pc.tailnet.ts.net' }),
  ]) {
    const res = await mod.relayFetch(remote(), '/api/agents', { method: 'POST', body: '{}' }, { incoming });
    assert.equal(res.status, 200);
  }
  assert.equal(seen.length, 2);
  assert.equal(mod.provenSameOrigin(browser({ 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(mod.provenSameOrigin(browser({ origin: 'https://evil.example', host: '127.0.0.1:3100', 'x-forwarded-host': 'pc.tailnet.ts.net' })), false);
});

test('remote: a same-origin mutation and a read are relayed', async () => {
  const post = await mod.relayFetch(remote(), '/api/agents', { method: 'post', body: '{}' }, {
    incoming: browser({ 'sec-fetch-site': 'same-origin' }),
  });
  assert.equal(post.status, 200);
  const get = await mod.relayFetch(remote(), '/api/agents');
  assert.equal(get.status, 200);
  assert.deepEqual(seen.map((s) => s.method), ['POST', 'GET']);
});

test('remote: a read started by another site is refused, a same-origin or typed one is relayed', async () => {
  for (const site of ['cross-site', 'same-site', 'Cross-Site']) {
    for (const method of ['GET', 'HEAD']) {
      const res = await mod.relayFetch(remote(), '/api/agents', { method }, { incoming: browser({ 'sec-fetch-site': site }) });
      assert.equal(res.status, 403, `${method} ${site}`);
    }
  }
  assert.equal(seen.length, 0, 'nothing reached the remote');
  for (const incoming of [browser({ 'sec-fetch-site': 'same-origin' }), browser({ 'sec-fetch-site': 'none' }), browser({})]) {
    assert.equal((await mod.relayFetch(remote(), '/api/agents', {}, { incoming })).status, 200);
  }
  assert.equal(seen.length, 3);
  // The local daemon keeps its own rule: the relay does not filter its reads.
  const local = await mod.relayFetch(mod.localTarget(), '/api/agents', {}, { incoming: browser({ 'sec-fetch-site': 'cross-site' }) });
  assert.equal(local.status, 200);
});

test('remote: plain HTTP is refused off loopback, and so is a URL with credentials', async () => {
  for (const url of ['http://192.168.1.10:3001', 'http://rooks.example', `http://user:pw@127.0.0.1:1`, 'ftp://x', 'nope']) {
    const res = await mod.relayFetch(remote(url), '/api/agents');
    assert.equal(res.status, 502, url);
    assert.equal((await res.json() as { error: string }).error, 'machine_insecure', url);
  }
  assert.equal(mod.remoteUrlAllowed('https://rooks.example'), true);
  assert.equal(mod.remoteUrlAllowed('http://localhost:3001'), true);
  assert.equal(mod.remoteUrlAllowed('http://[::1]:3001'), true);
  assert.equal(mod.remoteUrlAllowed('http://127.0.0.1.evil.example'), false);
});

test('remote: a redirect is neither followed nor forwarded', async () => {
  handler = (_req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
    res.end();
  };
  const res = await mod.relayFetch(remote(), '/api/agents');
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('location'), null);
  assert.equal((await res.json() as { error: string }).error, 'machine_redirect');
  assert.equal(seen.length, 1);
});

test('remote: an unreachable machine answers a typed JSON 502, not an exception', async () => {
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, '127.0.0.1', () => done()));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((done) => closed.close(() => done()));
  const res = await mod.relayFetch(remote(`http://127.0.0.1:${port}`), '/api/agents');
  assert.equal(res.status, 502);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.equal((await res.json() as { error: string }).error, 'machine_unreachable');
});

// ---- WebSocket upgrades ----------------------------------------------------

const sameOrigin = { host: 'app.test:3101', origin: 'https://app.test:3101' };
const nodeHeaders = (h: Record<string, string>) => mod.nodeRequestHeaders(h);

test('a Node request is read like a Fetch one', () => {
  const h = mod.nodeRequestHeaders({ cookie: 'rooks_machine=vps', 'x-forwarded-for': ['a', 'b'] as unknown as string });
  assert.equal(h.get('Cookie'), 'rooks_machine=vps');
  assert.equal(h.get('x-forwarded-for'), 'a, b');
  assert.equal(h.get('origin'), null);
});

test('local upgrade: the session cookie as given, and nothing else', async () => {
  assert.deepEqual(await mod.upgradeCredential(mod.localTarget(), nodeHeaders({}), 'rooks_session=s'), { ok: true, url: daemonBase, headers: { cookie: 'rooks_session=s' } });
  assert.deepEqual(await mod.upgradeCredential(mod.localTarget(), nodeHeaders({}), undefined), { ok: true, url: daemonBase, headers: {} });
});

test('remote upgrade: the device token only — never the session cookie, never the daemon token', async () => {
  const got = await mod.upgradeCredential(remote('https://vps.example'), nodeHeaders(sameOrigin), 'rooks_session=s');
  assert.deepEqual(got, {
    ok: true,
    url: 'https://vps.example',
    headers: { authorization: 'Bearer device-token-1', origin: 'https://vps.example', 'x-forwarded-host': 'vps.example' },
  });
  assert.ok(!JSON.stringify(got).includes(DAEMON_TOKEN));
});

test('remote upgrade: Origin and X-Forwarded-Host name the machine, as its TLS proxy will', async () => {
  // The browser's origin is checked here; over there, the daemon compares the
  // Origin with the host it was reached at, which its proxy writes over
  // X-Forwarded-Host: the machine's own name, port included.
  const got = await mod.upgradeCredential(remote('https://vps.tailnet.ts.net:8443'), nodeHeaders(sameOrigin), undefined);
  assert.equal(got.ok && got.headers.origin, 'https://vps.tailnet.ts.net:8443');
  assert.equal(got.ok && got.headers['x-forwarded-host'], 'vps.tailnet.ts.net:8443');
  assert.equal(got.ok && new URL(got.headers.origin!).host, got.ok && got.headers['x-forwarded-host']);
});

test('remote upgrade: a missing, opaque or foreign Origin is refused by the relay', async () => {
  const t = remote('https://vps.example');
  assert.deepEqual(await mod.upgradeCredential(t, nodeHeaders({ host: 'app.test:3101' }), undefined), { ok: false, status: 403 });
  assert.deepEqual(await mod.upgradeCredential(t, nodeHeaders({ host: 'app.test:3101', origin: 'null' }), undefined), { ok: false, status: 403 });
  assert.deepEqual(await mod.upgradeCredential(t, nodeHeaders({ host: 'app.test:3101', origin: 'https://evil.example' }), undefined), { ok: false, status: 403 });
  // Behind a reverse proxy, the host the browser reached is the forwarded one.
  const proxied = { host: '127.0.0.1:3100', 'x-forwarded-host': 'pc.tailnet.ts.net', origin: 'https://pc.tailnet.ts.net' };
  assert.equal((await mod.upgradeCredential(t, nodeHeaders(proxied), undefined)).ok, true);
});

test('remote upgrade: plain HTTP off loopback and a failing token store are refused', async () => {
  assert.deepEqual(await mod.upgradeCredential(remote('http://vps.example'), nodeHeaders(sameOrigin), undefined), { ok: false, status: 502 });
  const broken: import('./target').RemoteTarget = { ...remote('https://vps.example'), deviceToken: async () => { throw new Error('no token'); } };
  assert.deepEqual(await mod.upgradeCredential(broken, nodeHeaders(sameOrigin), undefined), { ok: false, status: 502 });
});

test('a Node request pinned by X-Rooks-Machine resolves like a Fetch one', async () => {
  const t = await mod.resolveTarget({ headers: nodeHeaders({ 'x-rooks-machine': 'vps', cookie: `rooks_session=${SESSION}; rooks_machine=local`, ...sameOrigin }) });
  assert.equal(t.kind, 'remote');
  assert.equal(t.id, 'vps');
  const other = await mod.resolveTarget({ headers: nodeHeaders({ 'x-rooks-machine': 'bobs-machine', cookie: `rooks_session=${SESSION}`, ...sameOrigin }) });
  assert.deepEqual(await mod.upgradeCredential(other, nodeHeaders(sameOrigin), undefined), { ok: false, status: 404 });
  const anonymous = await mod.resolveTarget({ headers: nodeHeaders({ 'x-rooks-machine': 'vps', ...sameOrigin }) });
  assert.deepEqual(await mod.upgradeCredential(anonymous, nodeHeaders(sameOrigin), undefined), { ok: false, status: 401 });
});

test('remote upgrade without a local session: refused, the remote never asked', async () => {
  const t = await mod.resolveTarget({ headers: nodeHeaders({ cookie: 'rooks_machine=vps', ...sameOrigin }) });
  assert.deepEqual(await mod.upgradeCredential(t, nodeHeaders(sameOrigin), undefined), { ok: false, status: 401 });
  assert.equal(daemonSeen.length, 0);
});
