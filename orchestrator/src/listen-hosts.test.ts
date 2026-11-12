import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { closeAll, listenAddresses, listenAll, listenHostsFor } from './listen-hosts.js';
import { NovaConfigSchema } from './config/schema.js';

/** Resolves with the connection error code, or `connected`. */
function probe(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000, () => { socket.destroy(); resolve('timeout'); });
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
}

function externalIPv4(): string | undefined {
  return Object.values(networkInterfaces()).flat()
    .find(info => info && info.family === 'IPv4' && !info.internal)?.address;
}

test('a loopback host binds both families, the configured one first', () => {
  assert.deepEqual(listenHostsFor('127.0.0.1'), ['127.0.0.1', '::1']);
  assert.deepEqual(listenHostsFor('localhost'), ['127.0.0.1', '::1']);
  assert.deepEqual(listenHostsFor('::1'), ['::1', '127.0.0.1']);
  assert.deepEqual(listenHostsFor('[::1]'), ['::1', '127.0.0.1']);
});

test('an exposed host is bound as configured, plus the loopbacks its local clients use', () => {
  assert.deepEqual(listenHostsFor('192.168.1.10'), ['192.168.1.10', '127.0.0.1', '::1']);
  assert.deepEqual(listenHostsFor('0.0.0.0'), ['0.0.0.0', '::1']);
  assert.deepEqual(listenHostsFor('::'), ['::']);
});

test('the daemon binds through listenAll on daemon.listen.host, never app.listen (TODO #339)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./kernel-boot.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('app.listen('), 'app.listen() without a host binds every interface');
  assert.ok(source.includes('listenAll(app, listenHost'));
  assert.ok(source.includes('config().daemon.listen.host'));
});

test('a loopback listener answers on 127.0.0.1 and ::1, and refuses the LAN (TODO #339)', async (t) => {
  const warnings: string[] = [];
  const servers: Server[] = await listenAll((_req, res) => { res.end('ok'); }, '127.0.0.1', 0, w => warnings.push(w));
  t.after(() => closeAll(servers));
  const port = (servers[0]!.address() as AddressInfo).port;

  assert.equal((servers[0]!.address() as AddressInfo).address, '127.0.0.1');
  assert.equal(await probe('127.0.0.1', port), 'connected');

  if (servers.length === 2) {
    assert.equal((servers[1]!.address() as AddressInfo).port, port, 'both families on the same port');
    assert.equal(await probe('::1', port), 'connected');
  } else {
    t.diagnostic(`::1 unavailable here: ${warnings.join('; ')}`);
  }

  const lan = externalIPv4();
  if (!lan) { t.diagnostic('no non-loopback IPv4 on this machine'); return; }
  // Not `ECONNREFUSED` exactly: Windows retries a refused SYN to its own address and may time out first.
  assert.notEqual(await probe(lan, port), 'connected');
});

test('a daemon bound to a machine address still answers its local clients on the loopback', async (t) => {
  const lan = externalIPv4();
  if (!lan) { t.diagnostic('no non-loopback IPv4 on this machine'); return; }
  const servers = await listenAll((_req, res) => { res.end('ok'); }, lan, 0, () => {});
  t.after(() => closeAll(servers));
  const port = (servers[0]!.address() as AddressInfo).port;
  assert.equal(await probe(lan, port), 'connected');
  assert.equal(await probe('127.0.0.1', port), 'connected');
});

test('the primary bind failing rejects, so the daemon can say who holds the port', async (t) => {
  const holder = await listenAll((_req, res) => { res.end(); }, '127.0.0.1', 0, () => {});
  t.after(() => closeAll(holder));
  const port = (holder[0]!.address() as AddressInfo).port;
  await assert.rejects(listenAll((_req, res) => { res.end(); }, '127.0.0.1', port, () => {}), { code: 'EADDRINUSE' });
});

test('daemon.listen.extraHosts refuses wildcards and hostnames — no way back to every interface', () => {
  for (const extra of ['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', 'localhost', 'docker0', '']) {
    const parsed = NovaConfigSchema.safeParse({ daemon: { listen: { extraHosts: [extra] } } });
    assert.equal(parsed.success, false, `${JSON.stringify(extra)} must be refused`);
  }
  const ok = NovaConfigSchema.parse({ daemon: { listen: { extraHosts: ['172.17.0.1'] } } });
  assert.deepEqual(ok.daemon.listen.extraHosts, ['172.17.0.1']);
  assert.equal(ok.daemon.listen.host, '127.0.0.1', 'extras never change the host the auth guards decide on');
  assert.deepEqual(NovaConfigSchema.parse({}).daemon.listen.extraHosts, []);
});

test('extra hosts are bound after the loopbacks, deduplicated', () => {
  assert.deepEqual(listenAddresses('127.0.0.1'), ['127.0.0.1', '::1']);
  assert.deepEqual(listenAddresses('127.0.0.1', ['172.17.0.1', '[::1]']), ['127.0.0.1', '::1', '172.17.0.1']);
});

test('both bind sites pass daemon.listen.extraHosts', async () => {
  const { readFileSync } = await import('node:fs');
  const boot = readFileSync(new URL('./kernel-boot.ts', import.meta.url), 'utf8');
  assert.ok(boot.includes('listenAll(app, listenHost, port, console.warn, extraHosts)'));
  const update = readFileSync(new URL('./data-update-boot.ts', import.meta.url), 'utf8');
  assert.ok(update.includes('cfg.daemon.listen.extraHosts'));
});
