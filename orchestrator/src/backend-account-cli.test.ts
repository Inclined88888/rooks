/**
 * `rooks backend-account` (TODO #330): the daemon route REPLACES the list of
 * grantees, so `grant` and `revoke` must read it first and send back the whole
 * list, never just the user they name.
 *
 * HTTP witness on 127.0.0.1:0, never the production port. Each case sets its
 * own ROOKS_HOME.
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-backend-account-cli-'));

const ROOKS = fileURLToPath(new URL('../bin/rooks', import.meta.url));

type Seen = { method: string; url: string; body: string };
type Account = { id: string; instance: string; name: string; ownerUserId: string | null; state: string; connected: boolean; grantedTo?: string[] };

const USERS = [
  { id: 'u-owner', email: 'owner@example.com' },
  { id: 'u-ada', email: 'ada@example.com' },
  { id: 'u-bob', email: 'bob@example.com' },
];

function runRooks(args: string[], url: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ROOKS, ...args], {
      env: { ...process.env, ROOKS_API: url, ROOKS_HOME: mkdtempSync(join(tmpdir(), 'rooks-backend-account-home-')) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += String(c); });
    child.stderr.on('data', (c: Buffer) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startMock(account: Account): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += String(c); });
      req.on('end', () => {
        const url = req.url ?? '';
        seen.push({ method: req.method ?? '', url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (url === '/api/users') return void res.end(JSON.stringify({ users: USERS }));
        if (url === '/api/backends/accounts') return void res.end(JSON.stringify({ accounts: [account], backends: ['claude'] }));
        if (req.method === 'PUT' && url === `/api/backends/accounts/${account.id}/grants`) {
          const { userIds } = JSON.parse(body) as { userIds: string[] };
          return void res.end(JSON.stringify({ account: { ...account, grantedTo: userIds } }));
        }
        res.writeHead(404);
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return void reject(new Error('unexpected listen address'));
      assert.notEqual(addr.port, 3000, 'the witness must not take the production port');
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        seen,
        close: () => new Promise<void>((ok, ko) => server.close((e) => e ? ko(e) : ok())),
      });
    });
  });
}

const account = (grantedTo?: string[]): Account => ({
  id: 'k3f9a2b1c0', instance: 'claude@k3f9a2b1c0', name: 'Perso', ownerUserId: 'u-owner', state: 'active', connected: true,
  ...(grantedTo ? { grantedTo } : {}),
});

const puts = (seen: Seen[]) => seen.filter((s) => s.method === 'PUT').map((s) => JSON.parse(s.body) as { userIds: string[] });

test('grant adds the users to the current list, by email or id, never the owner', async () => {
  const mock = await startMock(account(['u-bob']));
  try {
    const r = await runRooks(['backend-account', 'grant', 'claude@k3f9a2b1c0', '--user', 'ada@example.com,u-owner'], mock.url);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(puts(mock.seen), [{ userIds: ['u-bob', 'u-ada'] }]);
  } finally { await mock.close(); }
});

test('revoke removes only the users it names', async () => {
  const mock = await startMock(account(['u-bob', 'u-ada']));
  try {
    const r = await runRooks(['backend-account', 'revoke', 'k3f9a2b1c0', '--user', 'u-ada'], mock.url);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(puts(mock.seen), [{ userIds: ['u-bob'] }]);
  } finally { await mock.close(); }
});

test('a caller who cannot read the grants changes nothing', async () => {
  // The daemon hides `grantedTo` from anyone but the superadmin: sending a
  // list built without it would wipe the real one.
  const mock = await startMock(account());
  try {
    const r = await runRooks(['backend-account', 'grant', 'k3f9a2b1c0', '--user', 'ada@example.com'], mock.url);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /only the superadmin/);
    assert.equal(puts(mock.seen).length, 0);
  } finally { await mock.close(); }
});

test('unknown account or user, or a missing --user, are refused before any change', async () => {
  const mock = await startMock(account([]));
  try {
    assert.equal((await runRooks(['backend-account', 'grant', 'nope', '--user', 'u-ada'], mock.url)).code, 2);
    assert.equal((await runRooks(['backend-account', 'grant', 'k3f9a2b1c0', '--user', 'nobody@example.com'], mock.url)).code, 2);
    assert.equal((await runRooks(['backend-account', 'grant', 'k3f9a2b1c0'], mock.url)).code, 64);
    assert.equal(puts(mock.seen).length, 0);
  } finally { await mock.close(); }
});

test('list names the owner and the users an account is assigned to', async () => {
  const mock = await startMock(account(['u-ada']));
  try {
    const r = await runRooks(['backend-account', 'list'], mock.url);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /claude@k3f9a2b1c0 +Perso +\[active\] +owner: owner@example\.com/);
    assert.match(r.stdout, /assigned to: ada@example\.com/);
  } finally { await mock.close(); }
});
