/**
 * `POST /api/agents/:id/send` on a backend out of quota: the 429 tells apart a
 * conversation with no fallback from one whose fallback exists but would not
 * start (TODO #721). The second gives the reason, without secret or home path.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import express from 'express';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
process.env.ROOKS_FALLBACK_ENABLED = '1';
const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
// A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
await stubCliBinaries('claude', 'codex');
await stubCodexSignIn();
await mountOfficialProviders();
const { getHost } = await import('./host/index.js');
const { spawnAgent, upsertAgent, killAgent } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { backendNames } = await import('./backends/index.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { clearBackendCooldown, noteBackendRateLimit } = await import('./backend-fallback.js');
const { setRedactionSource } = await import('./secrets/redact.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');

invalidateSettingsCache();
const VAULT_VALUE = 'vault-value-1234567890';
const previousSource = setRedactionSource(() => [VAULT_VALUE]);

const host = getHost();
const originalSpawn = host.spawn;
let spawnFailure: string | null = null;
const children: ChildProcessWithoutNullStreams[] = [];
host.spawn = (() => {
  if (spawnFailure) throw Object.assign(new Error(spawnFailure), { code: 'ENOENT' });
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 4444; child.exitCode = null; child.signalCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true; };
  children.push(child);
  return child;
}) as typeof host.spawn;

const app = express();
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;

after(() => {
  server.close();
  host.spawn = originalSpawn;
  setRedactionSource(previousSource);
  for (const backend of backendNames()) clearBackendCooldown(backend);
});

/** A chat between two turns, whose backend has just run out of quota. */
async function dryChat(): Promise<string> {
  const name = `send-fallback-${randomUUID().slice(0, 8)}`;
  upsertAgent({ name, system_prompt: 'Test chat agent.', config: {
    cwd: process.env.ROOKS_HOME, backend: 'claude', model: 'sonnet',
    skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'acceptEdits',
  } });
  for (const backend of backendNames()) clearBackendCooldown(backend);
  const id = await spawnAgent(name, 'First question.');
  const child = children.at(-1)!;
  for (const event of [
    { type: 'system', subtype: 'init', session_id: `session-${id}` },
    { type: 'result', is_error: false, result: 'Answered.' },
  ]) child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
  noteBackendRateLimit('claude', { kind: 'rate_limit', window: 'five_hour', resetsAt: Date.now() + 3600_000, source: 'event', pending: false });
  return id;
}

async function send(missionId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/agents/${missionId}/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'Next question.' }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

test('no fallback at all: the refusal says so', { timeout: 20000 }, async () => {
  const id = await dryChat();
  try {
    dbApi.setSeriesFallback(id, 'orchestrator', null, null);
    const refused = await send(id);
    assert.equal(refused.status, 429);
    assert.equal(refused.body.code, 'backend_exhausted');
    assert.equal(refused.body.backend, 'claude');
    assert.equal(refused.body.error, 'backend claude is out of quota and no fallback is available');
    assert.equal('fallback' in refused.body, false);
    assert.equal(typeof refused.body.resetsAt, 'number');
  } finally {
    killAgent(id, { source: 'test' });
  }
});

test('a fallback that does not start: the refusal names it and its reason, without secret', { timeout: 20000 }, async () => {
  const id = await dryChat();
  const homePath = join(homedir(), 'bin', 'codex');
  try {
    dbApi.setSeriesFallback(id, 'orchestrator', 'codex', null);
    spawnFailure = `cannot start ${homePath} with token ${VAULT_VALUE}`;
    const refused = await send(id);
    assert.equal(refused.status, 429);
    assert.equal(refused.body.code, 'backend_exhausted');
    assert.equal(refused.body.backend, 'claude');
    assert.equal(refused.body.fallback, 'codex');
    assert.equal(typeof refused.body.resetsAt, 'number');
    const error = String(refused.body.error);
    assert.match(error, /^backend claude is out of quota and its fallback codex did not start: cannot start /);
    assert.doesNotMatch(error, /no fallback is available/);
    assert.equal(JSON.stringify(refused.body).includes(VAULT_VALUE), false, 'no vault value in the answer');
    assert.equal(error.includes(homedir()), false, 'no home path in the answer');
    assert.equal(dbApi.getMission(id)?.backend_override ?? null, null, 'the chat stays on its backend');
  } finally {
    spawnFailure = null;
    killAgent(id, { source: 'test' });
  }
});
