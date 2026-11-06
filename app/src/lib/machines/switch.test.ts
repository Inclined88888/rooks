/**
 * The switch writes `timon_machine` only for a machine the local daemon vouches
 * for, reachable and speaking a contract this app drives — and never for
 * another site's page.
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;

type SwitchModule = typeof import('./switch');

const SESSION = 'local-session-of-alice';
const seen: { url: string; headers: IncomingMessage['headers'] }[] = [];
let answer: (req: IncomingMessage, res: ServerResponse) => void = () => {};
const daemon = createServer((req, res) => {
  seen.push({ url: req.url ?? '', headers: req.headers });
  answer(req, res);
});
let mod!: SwitchModule;
let home = '';

function reply(status: number, body: unknown): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

const online = (apiLevel: unknown) => reply(200, { machine: { id: 'vps', status: 'online' }, reachable: true, version: '0.1.6', apiLevel });

test.before(async () => {
  const base = await new Promise<string>((done) => daemon.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(daemon.address() as AddressInfo).port}`)));
  home = mkdtempSync(join(tmpdir(), 'timon-switch-'));
  process.env.TIMON_HOME = home;
  process.env.ORCHESTRATOR_URL = base;
  mod = await import('./switch');
});

test.after(() => {
  daemon.closeAllConnections();
  daemon.close();
  rmSync(home, { recursive: true, force: true });
});

test.beforeEach(() => {
  seen.length = 0;
  answer = online(1);
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://app.test/api/ui/machines/active', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: `timon_session=${SESSION}`, ...headers },
    body: JSON.stringify(body),
  });
}

async function run(req: Request): Promise<{ status: number; body: Record<string, unknown>; cookie: string | null }> {
  const res = await mod.switchActiveMachine(req);
  return { status: res.status, body: await res.json() as Record<string, unknown>, cookie: res.headers.get('set-cookie') };
}

test('a machine of this person, reachable and compatible: the cookie names it', async () => {
  const out = await run(post({ id: 'vps' }));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { id: 'vps', warning: null });
  assert.match(out.cookie ?? '', /^timon_machine=vps; Max-Age=\d+; Path=\/; SameSite=Lax; HttpOnly$/);
  // Asked to the local daemon, with the local session and nothing else.
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, '/api/machines/vps/status');
  assert.equal(seen[0]!.headers.cookie, `timon_session=${SESSION}`);
  assert.equal(seen[0]!.headers.authorization, undefined);
});

test('back to this computer: the cookie is cleared, nothing is asked', async () => {
  const out = await run(post({ id: 'local' }, { cookie: '' }));
  assert.equal(out.status, 200);
  assert.match(out.cookie ?? '', /^timon_machine=; Max-Age=0;/);
  assert.equal(seen.length, 0);
});

test('behind an HTTPS proxy the cookie is Secure', async () => {
  const out = await run(post({ id: 'vps' }, { 'x-forwarded-proto': 'https' }));
  assert.match(out.cookie ?? '', /; Secure$/);
});

test('another site cannot move this browser onto a machine', async () => {
  for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
    const out = await run(post({ id: 'vps' }, headers));
    assert.equal(out.status, 403);
    assert.equal(out.cookie, null);
  }
  const back = await run(post({ id: 'local' }, { 'sec-fetch-site': 'cross-site' }));
  assert.equal(back.status, 403);
  assert.equal(seen.length, 0);
});

test('an id that is not one, or no session: refused before the daemon is asked', async () => {
  for (const id of ['../credential', 'a/b', '', 42, null]) {
    const out = await run(post({ id }));
    assert.equal(out.status, 400, String(id));
    assert.equal(out.cookie, null);
  }
  const anonymous = await run(post({ id: 'vps' }, { cookie: '' }));
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error, 'machine_session_required');
  assert.equal(anonymous.cookie, null);
  assert.equal(seen.length, 0);
});

test('a machine the daemon does not vouch for leaves the cookie alone', async () => {
  for (const [status, body, expected, error] of [
    [404, { error: 'machine not found' }, 404, 'machine_unknown'],
    [401, { error: 'unauthorized' }, 401, 'machine_session_required'],
    [503, { error: 'vault_unavailable' }, 503, 'vault_unavailable'],
    [500, { error: 'boom' }, 502, 'machine_credential_unavailable'],
  ] as const) {
    answer = reply(status, body);
    const out = await run(post({ id: 'vps' }));
    assert.equal(out.status, expected, String(status));
    assert.equal(out.body.error, error);
    assert.equal(out.cookie, null);
  }
});

test('an unreachable machine, or one that revoked this computer, is not switched to', async () => {
  for (const why of ['unreachable', 'unauthorized', 'tls_error']) {
    answer = reply(200, { machine: { id: 'vps', status: why }, reachable: false, version: null, apiLevel: null });
    const out = await run(post({ id: 'vps' }));
    assert.equal(out.status, 502);
    assert.deepEqual(out.body, { error: 'machine_unreachable', status: why });
    assert.equal(out.cookie, null);
  }
});

test('multi-window V3: a desktop window\'s switch is checked the same way and writes no cookie', async () => {
  const out = await run(post({ id: 'vps', scope: 'window' }));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { id: 'vps', warning: null });
  assert.equal(out.cookie, null, 'the other windows and the browser keep their machine');
  assert.equal(seen[0]!.url, '/api/machines/vps/status');
  const home = await run(post({ id: 'local', scope: 'window' }));
  assert.equal(home.status, 200);
  assert.equal(home.cookie, null);
  // Still refused when the machine is not vouched for, and never by a foreign page.
  answer = reply(404, { error: 'machine not found' });
  assert.equal((await run(post({ id: 'vps', scope: 'window' }))).status, 404);
  assert.equal((await run(post({ id: 'vps', scope: 'window' }, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal((await run(post({ id: 'vps', scope: 'everything' }))).status, 400);
});

test('apiLevel: blocking below the minimum, a warning when newer or absent', async () => {
  answer = online(0);
  const old = await run(post({ id: 'vps' }));
  assert.equal(old.status, 409);
  assert.equal(old.body.error, 'machine_incompatible');
  assert.equal(old.cookie, null);

  answer = online(99);
  const newer = await run(post({ id: 'vps' }));
  assert.equal(newer.status, 200);
  assert.equal(newer.body.warning, 'api_level_newer');
  assert.ok(newer.cookie);

  answer = online(null);
  const silent = await run(post({ id: 'vps' }));
  assert.equal(silent.status, 200);
  assert.equal(silent.body.warning, 'api_level_unknown');
  assert.ok(silent.cookie);
});

test('no route of the app hands a machine credential to a browser', () => {
  const dir = fileURLToPath(new URL('../../app/api/ui/machines', import.meta.url));
  const files: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(dir);
  assert.ok(files.length >= 5);
  for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), /credential/i, file);
});
