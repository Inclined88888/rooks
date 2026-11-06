/**
 * `timon secret` — the CLI half of the vault (SECRETS-VAULT.md §9.3).
 *
 * The assertion that matters is the refusal: a value passed as an argument is
 * readable by any local process through /proc/<pid>/cmdline, so `set` must exit
 * non-zero rather than accept it "just this once". The rest of the suite checks
 * that the same value goes through on stdin, and that nothing the CLI prints
 * ever carries a stored value back.
 *
 * HTTP witness on 127.0.0.1:0, never the production :3000. Each case sets its
 * own TIMON_HOME. A child is only killed when it has a pid, never `0`.
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-secret-cli-'));

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));
const VALUE = 'value-that-must-only-travel-on-stdin';

type Seen = { method: string; url: string; body: string };

function runTimon(args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<{
  code: number | null; stdout: string; stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TIMON, ...args], {
      env,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += String(c); });
    child.stderr.on('data', (c: Buffer) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin!.end(stdin);
  });
}

function startMock(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const secrets = [
    { id: 'id-global', name: 'GITHUB_TOKEN', mode: 'inject', configured: true, note: null, broker_spec: null,
      grants: [{ scope_kind: 'global', scope_ref: null }], created_at: 1, updated_at: 1 },
    { id: 'id-daemon', name: 'VAPID_PRIVATE_KEY', mode: 'inject', configured: true, note: null, broker_spec: null,
      grants: [], created_at: 1, updated_at: 1 },
  ];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += String(c); });
      req.on('end', () => {
        const url = req.url ?? '';
        seen.push({ method: req.method ?? '', url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (url.startsWith('/api/secrets?') || url === '/api/secrets') {
          if (req.method === 'GET') return void res.end(JSON.stringify({ secrets }));
          return void res.end(JSON.stringify({ ...secrets[0], name: JSON.parse(body || '{}').name }));
        }
        if (url.includes('/grants')) {
          return void res.end(JSON.stringify({ name: 'GITHUB_TOKEN', grants: [{ scope_kind: 'agent', scope_ref: 'a.coder' }] }));
        }
        if (url.endsWith('/rekey')) return void res.end(JSON.stringify({ ok: true, rotated: 2 }));
        if (url.endsWith('/import-env')) {
          return void res.end(JSON.stringify({ ok: true, imported: ['TELEGRAM_BOT_TOKEN'], skipped: [], deletedSource: false }));
        }
        res.end(JSON.stringify({ ok: true, ...secrets[0] }));
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

function env(url: string): NodeJS.ProcessEnv {
  return { ...process.env, TIMON_API: url, TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-secret-home-')) };
}

test('set refuses a value passed as an argument, and says why', async () => {
  const mock = await startMock();
  try {
    const r = await runTimon(['secret', 'set', 'GITHUB_TOKEN', VALUE, '--scope', 'global'], env(mock.url), '');
    assert.notEqual(r.code, 0, 'a value on the command line was accepted');
    assert.match(r.stderr, /never passed as an argument/);
    assert.match(r.stderr, /cmdline/, 'the refusal must explain the reason, not just refuse');
    assert.equal(mock.seen.some((s) => s.body.includes(VALUE)), false, 'the value reached the daemon anyway');
  } finally { await mock.close(); }
});

test('set refuses to read a pipe it was not told about', async () => {
  const mock = await startMock();
  try {
    // The value IS on stdin, and stdin is not a TTY — the shape a cron job or a
    // here-doc takes. Without the explicit flag it must still be refused: the
    // command must never pick a value up by accident.
    const r = await runTimon(['secret', 'set', 'NO_FLAG', '--scope', 'global'], env(mock.url), VALUE);
    assert.notEqual(r.code, 0, 'the value was read without --stdin');
    assert.match(r.stderr, /--stdin/);
    assert.equal(mock.seen.some((s) => s.body.includes(VALUE)), false, 'the value reached the daemon anyway');
  } finally { await mock.close(); }
});

test('set accepts the value on stdin and creates the secret', async () => {
  const mock = await startMock();
  try {
    const r = await runTimon(['secret', 'set', 'NEW_TOKEN', '--scope', 'project:initech', '--stdin'], env(mock.url), `${VALUE}\n`);
    assert.equal(r.code, 0, r.stderr);
    const post = mock.seen.find((s) => s.method === 'POST' && s.url === '/api/secrets');
    assert.ok(post, 'no creation was sent');
    const sent = JSON.parse(post.body) as { name: string; value: string; grants: string[] };
    assert.equal(sent.name, 'NEW_TOKEN');
    // The trailing newline the shell adds is stripped; the value itself is not touched.
    assert.equal(sent.value, VALUE);
    assert.deepEqual(sent.grants, ['project:initech']);
  } finally { await mock.close(); }
});

test('set without --scope creates a daemon-only secret', async () => {
  const mock = await startMock();
  try {
    const r = await runTimon(['secret', 'set', 'DAEMON_ONLY', '--stdin'], env(mock.url), VALUE);
    assert.equal(r.code, 0, r.stderr);
    const post = mock.seen.find((s) => s.method === 'POST' && s.url === '/api/secrets')!;
    assert.deepEqual((JSON.parse(post.body) as { grants: string[] }).grants, []);
  } finally { await mock.close(); }
});

test('list prints scopes and never a value', async () => {
  const mock = await startMock();
  try {
    const r = await runTimon(['secret', 'list'], env(mock.url));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /GITHUB_TOKEN\s+inject\s+set\s+global/);
    assert.match(r.stdout, /VAPID_PRIVATE_KEY.*daemon only/);
    assert.ok(!r.stdout.includes(VALUE));
  } finally { await mock.close(); }
});

test('grant and revoke act on the named secret', async () => {
  const mock = await startMock();
  try {
    const granted = await runTimon(['secret', 'grant', 'GITHUB_TOKEN', '--scope', 'agent:a.coder'], env(mock.url));
    assert.equal(granted.code, 0, granted.stderr);
    assert.ok(mock.seen.some((s) => s.method === 'POST' && s.url === '/api/secrets/id-global/grants'));

    const revoked = await runTimon(['secret', 'revoke', 'GITHUB_TOKEN', '--scope', 'agent:a.coder'], env(mock.url));
    assert.equal(revoked.code, 0, revoked.stderr);
    assert.ok(mock.seen.some((s) => s.method === 'DELETE' && s.url.startsWith('/api/secrets/id-global/grants?scope=')));
  } finally { await mock.close(); }
});

test('import-env says the file is kept unless --delete-source', async () => {
  const mock = await startMock();
  try {
    const r = await runTimon(['secret', 'import-env'], env(mock.url));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /NO grant \(daemon only\)/);
    assert.match(r.stdout, /secrets\.env kept/);
    const post = mock.seen.find((s) => s.url === '/api/secrets/import-env')!;
    assert.equal((JSON.parse(post.body) as { deleteSource: boolean }).deleteSource, false);
  } finally { await mock.close(); }
});

test('rekey reports the rotation', async () => {
  const mock = await startMock();
  try {
    const r = await runTimon(['secret', 'rekey'], env(mock.url));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /rekeyed 2 secret\(s\)/);
  } finally { await mock.close(); }
});
