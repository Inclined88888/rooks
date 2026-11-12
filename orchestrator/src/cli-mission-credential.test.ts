/**
 * Inside a mission the `rooks` CLI and the `rooks` MCP server never fall back
 * to the operator's daemon-token: the delegation list (`orchestrates`) is
 * checked against the mission identity, and a daemon-token carries none.
 * Outside a mission, the daemon-token only goes to this home's own listener.
 *
 * Mock daemon on `127.0.0.1:0`, temporary ROOKS_HOME holding a decoy
 * `daemon-token` — never the machine's daemon.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOKS = fileURLToPath(new URL('../bin/rooks', import.meta.url));
const MCP = fileURLToPath(new URL('../bin/rooks-mcp.mjs', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'rooks-cli-mission-cred-'));
const DAEMON_TOKEN = 'decoy-daemon-token';
writeFileSync(join(home, 'daemon-token'), `${DAEMON_TOKEN}\n`);

async function withMock<T>(run: (url: string, seen: Array<string | undefined>) => Promise<T>): Promise<T> {
  const seen: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', status: 'running', turn_complete: true, events: [], tasks: [] }));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
}

/** The daemon this home declares: the only one its daemon-token may reach. */
function listenOn(port: number): void {
  writeFileSync(join(home, 'rooks.config.json'), JSON.stringify({ daemon: { listen: { host: '127.0.0.1', port } } }));
}

function env(url: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, ROOKS_HOME: home, ROOKS_API: url, ROOKS_ORCH_URL: url, ROOKS_RESOURCE_GUARD_ENABLED: '0', ...extra };
  for (const key of ['ROOKS_API_TOKEN', 'ROOKS_MISSION_ID']) if (!(key in extra)) delete e[key];
  return e;
}

function runCli(url: string, extra: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ROOKS, 'task', 'list'], { env: env(url, extra), stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', () => resolve());
  });
}

function runMcp(url: string, extra: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP], { env: env(url, extra), stdio: ['pipe', 'pipe', 'ignore'] });
    child.on('error', reject);
    child.on('close', () => resolve());
    child.stdout.on('data', (chunk: Buffer) => {
      if (String(chunk).includes('"id":2')) child.kill();
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'kanban_list', arguments: {} } })}\n`);
  });
}

for (const [label, run] of [['CLI', runCli], ['MCP server', runMcp]] as const) {
  test(`${label}: a mission never falls back to the daemon-token file`, async () => {
    await withMock(async (url, seen) => {
      await run(url, { ROOKS_MISSION_ID: 'mission-1' });
      assert.ok(seen.length > 0, 'the call reached the daemon');
      assert.ok(seen.every((auth) => auth === undefined), `no credential sent, saw ${JSON.stringify(seen)}`);
    });
  });

  test(`${label}: a mission uses its own token`, async () => {
    await withMock(async (url, seen) => {
      await run(url, { ROOKS_MISSION_ID: 'mission-1', ROOKS_API_TOKEN: 'mission-token' });
      assert.ok(seen.length > 0);
      assert.ok(seen.every((auth) => auth === 'Bearer mission-token'));
    });
  });

  test(`${label}: an operator terminal (no mission) still uses the daemon-token on its own listener`, async () => {
    await withMock(async (url, seen) => {
      listenOn(Number(new URL(url).port));
      await run(url, {});
      assert.ok(seen.length > 0);
      assert.ok(seen.every((auth) => auth === `Bearer ${DAEMON_TOKEN}`));
    });
  });

  test(`${label}: an operator terminal never sends the daemon-token to another daemon`, async () => {
    await withMock(async (url, seen) => {
      listenOn(Number(new URL(url).port) === 1 ? 2 : 1);
      await run(url, {});
      assert.ok(seen.length > 0, 'the call reached the daemon');
      assert.ok(seen.every((auth) => auth === undefined), `no credential sent, saw ${JSON.stringify(seen)}`);
    });
  });
}
