import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { isNova, probeFailureReason, probeHealth, waitForHealth, SERVICE_ID } from './health.js';

/** What the daemon actually answers — see `plugins-bundled/http/routes.ts`. */
const ROOKS_BODY = JSON.stringify({ ok: true, service: SERVICE_ID });

async function listen(
  handler: (status: number) => number,
  body: string = ROOKS_BODY,
): Promise<{ origin: string; server: Server }> {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.statusCode = handler(calls);
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  return { origin: `http://127.0.0.1:${addr.port}`, server };
}

test('a daemon that answers 200 is up', async () => {
  const { origin, server } = await listen(() => 200);
  try {
    const res = await probeHealth(origin);
    assert.deepEqual(res, { ok: true, status: 200, identity: 'rooks' });
    assert.equal(isNova(res), true);
  } finally {
    server.close();
  }
});

test('an unauthorized response is not proof of daemon identity', async () => {
  const { origin, server } = await listen(() => 401);
  try {
    const res = await probeHealth(origin);
    assert.equal(res.ok, true);
    assert.equal(res.status, 401);
    assert.equal(isNova(res), false);
  } finally {
    server.close();
  }
});

test('nothing listening is a failure, never a throw', async () => {
  // Port 1 is privileged and free: connecting fails immediately.
  const res = await probeHealth('http://127.0.0.1:1', 500);
  assert.equal(res.ok, false);
  assert.equal(res.status, null);
});

test('a probe failure names its cause: refused, or connected without a reply', async () => {
  // An ephemeral port just released: connecting is refused (port 1 would be
  // refused by fetch itself as a "bad port", with no cause to read).
  const gone = createTcpServer();
  await new Promise<void>((r) => gone.listen(0, '127.0.0.1', r));
  const freed = (gone.address() as AddressInfo).port;
  await new Promise<void>((r) => gone.close(() => r()));
  const refused = await probeHealth(`http://127.0.0.1:${freed}`, 500);
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', /connection refused: nothing listens/);
  // A socket that accepts and never answers is what a daemon busy on its main
  // thread looks like from outside (Windows tester, 21/10/2026).
  const mute = createTcpServer(() => {});
  await new Promise<void>((r) => mute.listen(0, '127.0.0.1', r));
  try {
    const port = (mute.address() as AddressInfo).port;
    const res = await probeHealth(`http://127.0.0.1:${port}`, 300);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /connected, but no reply in time/);
  } finally {
    mute.close();
  }
  assert.equal(probeFailureReason(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })), 'connection reset: the daemon closed it without replying');
  assert.equal(probeFailureReason(new TypeError('fetch failed', { cause: { code: 'EHOSTUNREACH' } })), 'EHOSTUNREACH: fetch failed');
  assert.equal(probeFailureReason(new Error('odd')), 'odd');
  const aggregate = new TypeError('fetch failed', { cause: Object.assign(new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })]), { code: undefined }) });
  assert.equal(probeFailureReason(aggregate), 'connection refused: nothing listens on the port');
});

test('waitForHealth returns as soon as the daemon comes up', async () => {
  const { origin, server } = await listen(() => 200);
  const port = origin.slice(origin.lastIndexOf(':') + 1);
  server.close();
  // The daemon appears late: the poll must catch it without burning its budget.
  const late = setTimeout(() => server.listen(Number(port), '127.0.0.1'), 300);
  try {
    const res = await waitForHealth(origin, 5000, 100);
    assert.equal(res.ok, true);
  } finally {
    clearTimeout(late);
    server.close();
  }
});

test('waitForHealth gives up on its budget', async () => {
  const started = Date.now();
  const res = await waitForHealth('http://127.0.0.1:1', 400, 50);
  assert.equal(res.ok, false);
  assert.ok(Date.now() - started < 3000);
});

/**
 * The failure this identity check exists for (step 5.6.4): another program holds :3000
 * on the developer's machine and answers its own `/api/health`. Read as "Rooks is up",
 * the shell opened a window on an app port nobody served — blank page, no
 * message. A server that answers without naming itself is `foreign`.
 */
test('another service on the port is not our daemon', async () => {
  const { origin, server } = await listen(() => 200, JSON.stringify({ ok: true }));
  try {
    const res = await probeHealth(origin);
    assert.equal(res.ok, true, 'something does answer');
    assert.equal(isNova(res), false, 'but it is not Rooks');
  } finally {
    server.close();
  }
});

test('a body that is not JSON at all is foreign too', async () => {
  const { origin, server } = await listen(() => 200, '<html>hello</html>');
  try {
    assert.equal(isNova(await probeHealth(origin)), false);
  } finally {
    server.close();
  }
});

test('waiting does not turn a foreign server into ours', async () => {
  const { origin, server } = await listen(() => 200, JSON.stringify({ ok: true }));
  try {
    const res = await waitForHealth(origin, 1000, 100);
    assert.equal(res.ok, true);
    assert.equal(isNova(res), false);
  } finally {
    server.close();
  }
});

test('a responding Rooks from a different home cannot reuse its account', async () => {
  const { instanceId } = await import('./service.js');
  const home = '/tmp/this-installation';
  const { origin, server } = await listen(() => 200, JSON.stringify({ service: SERVICE_ID, instance: instanceId(home) }));
  try {
    const result = await probeHealth(origin);
    assert.equal(isNova(result, home), true);
    assert.equal(isNova(result, '/tmp/fresh-installation'), false);
  } finally { server.close(); }
});

test('TODO #477: the probe reports whether the daemon is packaged, and only when it says so', async () => {
  for (const [body, packaged] of [[{ packaged: true }, true], [{ packaged: false }, false], [{}, undefined], [{ packaged: 'yes' }, undefined]] as const) {
    const { origin, server } = await listen(() => 200, JSON.stringify({ ok: true, service: SERVICE_ID, ...body }));
    try {
      const result = await probeHealth(origin);
      assert.equal(result.ok && result.packaged, result.ok ? packaged : false);
    } finally { server.close(); }
  }
});
