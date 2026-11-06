/**
 * `timon git-credential` — git's credential protocol (SECRETS-VAULT.md §6.2).
 *
 * The CLI is run as git would run it: a child process, key=value lines on
 * stdin, credential lines expected on stdout. The daemon is a witness HTTP
 * server on `127.0.0.1:0` — never the production port.
 */
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TIMON = fileURLToPath(new URL('../../bin/timon', import.meta.url));
const PASSWORD = 'ghp_a_long_enough_token_value';

type Seen = { url: string; body: string };

/** A witness daemon answering `/api/secrets/broker/git` with `reply`. */
async function withDaemon<T>(
  reply: (body: Record<string, unknown>) => { status: number; json: unknown },
  fn: (base: string, seen: Seen[]) => Promise<T>,
): Promise<T> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url ?? '', body: raw });
      const { status, json } = reply(raw ? JSON.parse(raw) : {});
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  assert.notEqual(port, 3000, 'the witness must not take the production port');
  try {
    return await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function runHelper(args: string[], stdin: string, api: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, TIMON_API: api, TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-gitcred-')) };
    delete env.TIMON_API_TOKEN;
    const child = spawn(process.execPath, [TIMON, 'git-credential', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

const OK = () => ({ status: 200, json: { username: 'x-access-token', password: PASSWORD } });

test('`get` on a covered host answers git with credential lines', async () => {
  await withDaemon(OK, async (base, seen) => {
    const { code, stdout } = await runHelper(['get'], 'protocol=https\nhost=github.com\npath=org/repo.git\n\n', base);
    assert.equal(code, 0);
    assert.equal(stdout, `username=x-access-token\npassword=${PASSWORD}\n\n`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, '/api/secrets/broker/git');
    // The host is what we asked about; the identity is never named by git.
    assert.equal(JSON.parse(seen[0]!.body).host, 'github.com');
  });
});

test('a port in the host is stripped before the allowlist ever sees it', async () => {
  await withDaemon(OK, async (base, seen) => {
    await runHelper(['get'], 'protocol=https\nhost=github.com:443\n\n', base);
    assert.equal(JSON.parse(seen[0]!.body).host, 'github.com');
  });
});

test('a refusal is silence, not an error — git falls through to its other helpers', async () => {
  await withDaemon(() => ({ status: 403, json: { error: 'no grant', code: 'no-grant' } }), async (base) => {
    const { code, stdout } = await runHelper(['get'], 'protocol=https\nhost=github.com\n\n', base);
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });
});

test('an unreachable daemon is silence too', async () => {
  // Port 1 is never listening; the helper must not make git fail because of us.
  const { code, stdout } = await runHelper(['get'], 'protocol=https\nhost=github.com\n\n', 'http://127.0.0.1:1');
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('`store` and `erase` are silent no-ops — the vault is the only store', async () => {
  await withDaemon(OK, async (base, seen) => {
    for (const op of ['store', 'erase']) {
      const { code, stdout } = await runHelper([op], `protocol=https\nhost=github.com\npassword=${PASSWORD}\n\n`, base);
      assert.equal(code, 0, op);
      assert.equal(stdout, '', op);
    }
    assert.equal(seen.length, 0, 'neither operation may reach the daemon');
  });
});

test('a non-https protocol is not answered — a password means nothing there', async () => {
  await withDaemon(OK, async (base, seen) => {
    const { stdout } = await runHelper(['get'], 'protocol=ssh\nhost=github.com\n\n', base);
    assert.equal(stdout, '');
    assert.equal(seen.length, 0);
  });
});
