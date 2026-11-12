/**
 * `host.isolation.egress.mode` defaults to `off` (decision of 31/10/2026, after
 * TODO #708). With no key in the config, the daemon binds no proxy port, no
 * mission gets `HTTP(S)_PROXY` or an `egress-proxy` credential, and the new-host
 * alert has nothing to fire on. A `log` written in the config still does all
 * of it, which is also what keeps the first half from passing by accident.
 */
import '../test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
// The runner's own proxy, if any, would be an upstream proxy: the injection steps aside for it.
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[name];

await import('../../tests/helpers/paid-license.js');
await import('../../tests/helpers/claude-provider.js');
const { missionEnv } = await import('../agent.js');
const { db, dbApi } = await import('../db.js');
const { EGRESS_PROXY_TOKEN_SCOPE } = await import('../users/permissions.js');
const { config, setConfig } = await import('../config/load.js');
const { NovaConfigSchema } = await import('../config/schema.js');
const { egressProxyAddress, startEgressProxy } = await import('./service.js');
const { listMissionEgress } = await import('./journal.js');

const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];

const egressTokens = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE scope = ?').get(EGRESS_PROXY_TOKEN_SCOPE) as { n: number }).n;
const newHostAlerts = (missionId: string): number =>
  dbApi.listNotifications({ limit: 50 }).filter((n) => n.anchor === `egress:${missionId}`).length;

test('with no egress key in the config: no proxy port, no proxy variable, no credential, no alert', async () => {
  assert.equal(NovaConfigSchema.parse({}).host.isolation.egress.mode, 'off');
  assert.equal(config().host.isolation.egress.mode, 'off');

  const stop = startEgressProxy();
  after(stop);
  // Long enough for a bind to complete, had one been started.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(egressProxyAddress(), null);

  const id = 'default-off-mission';
  dbApi.createMission(id, 'egress.agent', 'default mode');
  for (const untrusted of [false, true]) {
    const env = missionEnv({ missionId: id, agentName: 'egress.agent', cwd: tmpdir(), untrusted });
    for (const name of PROXY_ENV) assert.equal(env[name], undefined, name);
  }
  assert.equal(egressTokens(), 0);
  assert.equal(listMissionEgress(id, { limit: 10 }).connections.length, 0);
  assert.equal(newHostAlerts(id), 0);
});

test('`log` written in the config: the proxy listens, the mission gets its variables and credential, the journal and the alert work', async () => {
  const upstream = createHttpServer((_req, res) => { res.end('hello'); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  after(() => upstream.close());
  const upstreamPort = (upstream.address() as AddressInfo).port;

  setConfig(NovaConfigSchema.parse({ host: { isolation: { egress: { mode: 'log' } } } }));
  const stop = startEgressProxy();
  after(stop);
  for (let i = 0; i < 300 && !egressProxyAddress(); i += 1) await new Promise((r) => setTimeout(r, 10));
  const address = egressProxyAddress();
  assert.ok(address, 'the proxy did not start');

  const id = 'explicit-log-mission';
  dbApi.createMission(id, 'egress.agent', 'explicit log');
  const env = missionEnv({ missionId: id, agentName: 'egress.agent', cwd: tmpdir() });
  for (const name of PROXY_ENV) assert.ok(env[name], name);
  assert.equal(egressTokens(), 1);

  const url = new URL(env.HTTPS_PROXY!);
  const basic = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
  const socket = netConnect({ host: '127.0.0.1', port: address.port });
  await once(socket, 'connect');
  socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nProxy-Authorization: Basic ${basic}\r\n\r\n`);
  const [answer] = await once(socket, 'data') as [Buffer];
  assert.match(answer.toString(), /^HTTP\/1\.1 200 /);
  socket.destroy();

  const journaled = (): number => listMissionEgress(id, { limit: 10 }).connections.length;
  for (let i = 0; i < 300 && journaled() === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(journaled(), 1);
  assert.equal(newHostAlerts(id), 1);
});
