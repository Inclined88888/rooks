/**
 * `rooks task mark-merged` (TIM-0109): the CLI half of the board's "Merged
 * outside Rooks?" — the sha and the comment reach the daemon route, nothing
 * else. Witness HTTP server on `127.0.0.1:0`, never the machine's daemon.
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-cli-mark-merged-test-'));

const ROOKS = fileURLToPath(new URL('../bin/rooks', import.meta.url));

type Seen = { method?: string; url?: string; body?: unknown };

function run(args: string[], answer: { status: number; body: unknown }): Promise<{ code: number | null; stdout: string; stderr: string; seen: Seen }> {
  const seen: Seen = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += String(c); });
    req.on('end', () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.body = raw ? JSON.parse(raw) : undefined;
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const env = { ...process.env, ROOKS_API: `http://127.0.0.1:${port}`, ROOKS_RESOURCE_GUARD_ENABLED: '0' };
      delete env.ROOKS_API_TOKEN;
      const child = spawn(process.execPath, [ROOKS, 'task', 'mark-merged', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer | string) => { stdout += String(c); });
      child.stderr.on('data', (c: Buffer | string) => { stderr += String(c); });
      child.on('error', reject);
      child.on('close', (code) => server.close(() => resolve({ code, stdout, stderr, seen })));
    });
  });
}

test('posts the sha and the comment to the mark-merged route', async () => {
  const r = await run(['task-1', '--sha', 'abc1234', '--comment', 'PR #66'], { status: 200, body: { task: {}, verified: true } });
  assert.equal(r.code, 0);
  assert.equal(r.seen.method, 'POST');
  assert.equal(r.seen.url, '/api/tasks/task-1/mark-merged');
  assert.deepEqual(r.seen.body, { sha: 'abc1234', comment: 'PR #66' });
  assert.equal(r.stdout, 'task task-1 marked merged: abc1234\n');
});

test('says when the commit could not be verified', async () => {
  const r = await run(['task-1', '--sha', 'abc1234'], { status: 200, body: { task: {}, verified: false } });
  assert.deepEqual(r.seen.body, { sha: 'abc1234' });
  assert.match(r.stdout, /not verified/);
});

test('a refusal of the daemon fails the command', async () => {
  const r = await run(['task-1', '--sha', 'abc1234'], { status: 409, body: { error: 'Commit abc1234 is not in main of this repository.', code: 'sha_not_in_base' } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not in main/);
});

test('without an id or a sha it prints its usage', async () => {
  const r = await run(['task-1'], { status: 200, body: {} });
  assert.equal(r.code, 64);
  assert.match(r.stderr, /usage: rooks task mark-merged/);
  assert.equal(r.seen.url, undefined);
});
