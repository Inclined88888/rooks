/**
 * The egress journal and its new-host alert (TODO #590, T3): retention holds
 * per mission, by age and globally; a real proxy journals a connection without
 * its credential, path or query string; a host is new once per project, and a
 * mission meeting many new hosts raises a few notifications, never one per
 * connection.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
await import('../../tests/helpers/paid-license.js');
const { db, dbApi } = await import('../db.js');
const { createEgressProxy } = await import('./proxy.js');
const {
  learnEgressHost, listMissionEgress, missionEgressHosts, missionNewEgressHosts, pruneEgressJournal, recordEgress,
} = await import('./journal.js');
const { createNewHostAlerts } = await import('./alerts.js');
const { journalRecord, missionProjectKey, noteEgressOpen, sendNewHostNotification } = await import('./service.js');

type Record = Parameters<typeof recordEgress>[0];
const RETENTION = { perMission: 5, total: 12, maxAgeMs: 1_000, hostsPerProject: 3 };

function record(missionId: string, over: Partial<Record> = {}): Record {
  return { missionId, method: 'CONNECT', host: 'example.com', port: 443, status: 200, bytesOut: 10, bytesIn: 20, startedAt: Date.now(), durationMs: 5, ...over };
}

function countOf(missionId?: string): number {
  return missionId
    ? (db.prepare('SELECT COUNT(*) AS n FROM egress_log WHERE mission_id = ?').get(missionId) as { n: number }).n
    : (db.prepare('SELECT COUNT(*) AS n FROM egress_log').get() as { n: number }).n;
}

test('a chatty mission keeps only its most recent rows; the others are untouched', () => {
  const chatty = randomUUID();
  const quiet = randomUUID();
  recordEgress(record(quiet, { host: 'quiet.example' }), RETENTION);
  for (let i = 0; i < 40; i += 1) recordEgress(record(chatty, { port: 1000 + i }), RETENTION);
  assert.equal(countOf(chatty), 5);
  assert.deepEqual(listMissionEgress(chatty, { limit: 10 }).connections.map((row) => row.port), [1039, 1038, 1037, 1036, 1035]);
  assert.equal(countOf(quiet), 1);
});

test('the sweep drops rows past the age limit, then the oldest beyond the global cap', () => {
  db.prepare('DELETE FROM egress_log').run();
  const now = 1_000_000;
  const old = randomUUID();
  recordEgress(record(old, { startedAt: now - 5_000 }), RETENTION);
  const missions = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of missions) for (let i = 0; i < 5; i += 1) recordEgress(record(id, { startedAt: now }), RETENTION);
  assert.equal(countOf(), 16);
  assert.equal(pruneEgressJournal(now, RETENTION), 4);
  assert.equal(countOf(old), 0, 'past the age limit');
  assert.equal(countOf(), 12, 'global cap');
  assert.equal(countOf(missions[0]), 2, 'the oldest rows went first');
  assert.equal(countOf(missions[2]), 5);
});

test('paging walks back with `before`, and the host summary counts failures', () => {
  const id = randomUUID();
  for (let i = 0; i < 4; i += 1) recordEgress(record(id, { host: i % 2 ? 'A.Example.' : 'b.example', status: i === 3 ? 502 : 200, ...(i === 3 ? { error: 'ECONNREFUSED' } : {}) }));
  const first = listMissionEgress(id, { limit: 3 });
  assert.equal(first.connections.length, 3);
  assert.equal(first.hasMore, true);
  const second = listMissionEgress(id, { limit: 3, before: first.connections[2]!.id });
  assert.equal(second.connections.length, 1);
  assert.equal(second.hasMore, false);
  const hosts = missionEgressHosts(id);
  assert.deepEqual(hosts.map((h) => [h.host, h.connections, h.failures]), [['a.example', 2, 1], ['b.example', 2, 0]]);
});

test('a host is new once per project, and each project keeps a bounded memory of them', () => {
  const m1 = randomUUID();
  const m2 = randomUUID();
  assert.equal(learnEgressHost('project:p', 'Api.Example.com', m1, 1, RETENTION), true);
  assert.equal(learnEgressHost('project:p', 'api.example.com.', m2, 2, RETENTION), false, 'same host, another spelling');
  assert.equal(learnEgressHost('project:q', 'api.example.com', m2, 3, RETENTION), true, 'another project learns it for itself');
  assert.deepEqual(missionNewEgressHosts(m1).map((h) => h.host), ['api.example.com']);
  for (let i = 0; i < 5; i += 1) learnEgressHost('project:p', `h${i}.example`, m1, 10 + i, RETENTION);
  const kept = db.prepare("SELECT host FROM egress_known_hosts WHERE project_key = 'project:p' ORDER BY first_seen_at").all() as Array<{ host: string }>;
  assert.deepEqual(kept.map((row) => row.host), ['h2.example', 'h3.example', 'h4.example']);
});

test('alerts: the first new host at once, the next ones together after the window, nothing when quiet', () => {
  const sent: Array<{ missionId: string; hosts: string[]; more: number }> = [];
  const timers: Array<() => void> = [];
  const alerts = createNewHostAlerts({
    send: (alert) => sent.push({ missionId: alert.missionId, hosts: alert.hosts, more: alert.more }),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  alerts.noteNewHost('m', 'project:p', 'a.example');
  for (let i = 0; i < 14; i += 1) alerts.noteNewHost('m', 'project:p', `h${i}.example`);
  alerts.noteNewHost('m', 'project:p', 'h0.example');
  alerts.noteNewHost('other', 'project:p', 'z.example');
  assert.equal(sent.length, 2, 'one per mission so far');
  timers.shift()!();
  assert.equal(sent.length, 3);
  assert.equal(sent[2]!.hosts.length, 10);
  assert.equal(sent[2]!.more, 4);
  timers.shift()!(); // the other mission's window closes empty
  timers.shift()!(); // the first mission's next window, empty too: its state goes
  assert.equal(sent.length, 3);
  alerts.noteNewHost('m', 'project:p', 'later.example');
  assert.equal(sent.length, 4, 'after a quiet window, a new host alerts at once again');
  alerts.stop();
});

test('through a real proxy: one notification for many connections, no credential, path or query anywhere', async () => {
  const owner = createTestAccount(dbApi, { email: `o-${randomUUID()}@example.com`, name: 'Owner', passwordHash: 'x', isSuperadmin: false });
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'loner.agent', 'egress', undefined, owner.id);
  const otherId = randomUUID();
  dbApi.createMission(otherId, 'loner.agent', 'egress again', undefined, owner.id);
  assert.equal(missionProjectKey(missionId), 'agent:loner.agent');

  const upstream = createHttpServer((_req, res) => { res.end('ok'); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  after(() => { upstream.closeAllConnections(); upstream.close(); });
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const secret = `tok-${randomUUID()}`;
  const notified: string[] = [];
  const alerts = createNewHostAlerts({
    send: (alert) => { notified.push(alert.missionId); sendNewHostNotification(alert); },
  });
  after(() => alerts.stop());
  const proxy = createEgressProxy({
    authenticate: (id, token) => token === secret && (id === missionId || id === otherId),
    onOpen: (target) => noteEgressOpen(target, alerts),
    onRecord: journalRecord,
  });
  const address = await proxy.listen('127.0.0.1', 0);
  after(() => proxy.close());
  const basic = (id: string): string => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

  const get = (id: string): Promise<void> => new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: address.port, method: 'GET',
      path: `http://127.0.0.1:${upstreamPort}/private/path?api_key=${secret}`,
      headers: { 'Proxy-Authorization': basic(id) },
    }, (res) => { res.resume(); res.on('end', () => resolve()); });
    req.on('error', reject);
    req.end();
  });
  const tunnel = async (id: string): Promise<void> => {
    const socket = netConnect({ host: '127.0.0.1', port: address.port });
    await once(socket, 'connect');
    socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${basic(id)}\r\n\r\n`);
    await once(socket, 'data');
    socket.end();
    await once(socket, 'close');
  };

  for (let i = 0; i < 5; i += 1) await get(missionId);
  for (let i = 0; i < 3; i += 1) await tunnel(missionId);
  await get(otherId);
  for (let i = 0; i < 200 && countOf(missionId) < 8; i += 1) await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 200 && countOf(otherId) < 1; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(countOf(missionId), 8);

  assert.deepEqual(notified, [missionId], 'one alert for the first mission, none for a host its scope already knows');
  const rows = db.prepare('SELECT * FROM notifications WHERE mission_id IN (?, ?)').all(missionId, otherId) as Array<{ title: string; body: string; owner_user_id: string; anchor: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.owner_user_id, owner.id);
  assert.equal(rows[0]!.anchor, `egress:${missionId}`);
  assert.match(rows[0]!.body, /127\.0\.0\.1/);

  const everything = JSON.stringify([
    db.prepare('SELECT * FROM egress_log WHERE mission_id IN (?, ?)').all(missionId, otherId),
    db.prepare('SELECT * FROM egress_known_hosts').all(),
    rows,
  ]);
  for (const leak of [secret, '/private', 'api_key', Buffer.from(`${missionId}:${secret}`).toString('base64')]) {
    assert.equal(everything.includes(leak), false, `${leak} reached the journal or the alert`);
  }
});
