/**
 * `POST /api/agents/:id/send` on a backend out of quota switches the chat to
 * its fallback. When the turn carries files and that fallback cannot open them
 * (`capabilities.attachments: false`), the route refuses readably instead of
 * handing the turn over: the files are announced by their path on this disk,
 * and the fallback would answer as if it had read them.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
process.env.ROOKS_FALLBACK_ENABLED = '1';
const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');

const { spawnAgent, upsertAgent, killAgent } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { chatAttachmentsRoot } = await import('./chat-attachments.js');
const { backendNames } = await import('./backends/index.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { clearBackendCooldown, noteBackendRateLimit } = await import('./backend-fallback.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
const { memoryDialect } = await import('../tests/helpers/example-dialects.js') as {
  memoryDialect: import('./backends/types.js').RemoteDialect;
};

invalidateSettingsCache();
const OWNER = 'send-fallback-attachments-test';
const FALLBACK = 'send-fallback-no-files';
const disposers = [
  registerDialect(OWNER, 'send-fallback-remote', memoryDialect),
  registerProfile(OWNER, {
    id: FALLBACK, dialect: 'send-fallback-remote', label: 'no files', defaultModel: null, models: [], env: {},
    capabilities: { attachments: false },
  }),
];

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

test('the quota fallback refuses a turn with files when the fallback cannot open them', { timeout: 20000 }, async () => {
  const host = getHost();
  const original = host.spawn;
  const children: ChildProcessWithoutNullStreams[] = [];
  host.spawn = (() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4343; child.exitCode = null; child.signalCode = null;
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true; };
    children.push(child);
    return child;
  }) as typeof host.spawn;
  const emit = (child: ChildProcessWithoutNullStreams, event: unknown) =>
    child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  let missionId: string | null = null;
  try {
    for (const backend of backendNames()) clearBackendCooldown(backend);
    upsertAgent({ name: 'send-fallback-chat', system_prompt: 'Test chat agent.', config: {
      cwd: process.env.ROOKS_HOME, backend: 'claude', model: 'sonnet',
      skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'acceptEdits',
    } });
    missionId = await spawnAgent('send-fallback-chat', 'First question.');
    const child = children.at(-1)!;
    emit(child, { type: 'system', subtype: 'init', session_id: 'send-fallback-session' });
    emit(child, { type: 'result', is_error: false, result: 'Answered.' });
    dbApi.setSeriesFallback(missionId, 'orchestrator', FALLBACK, null);
    noteBackendRateLimit('claude', { kind: 'rate_limit', window: 'five_hour', resetsAt: Date.now() + 3600_000, source: 'event', pending: false });

    const refused = await post(`/api/agents/${missionId}/send`, {
      input: 'Read the attached notes.',
      attachments: [{ name: 'notes.txt', mime: 'text/plain', data: Buffer.from('hello').toString('base64') }],
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'attachments_unsupported');
    assert.equal(refused.body.backend, 'claude');
    assert.equal(refused.body.fallback, FALLBACK);
    assert.match(String(refused.body.error), /claude is out of quota/);
    assert.match(String(refused.body.error), new RegExp(`${FALLBACK} does not accept attached files`));
    assert.equal(dbApi.getMission(missionId)?.backend_override ?? null, null, 'the chat must not have switched');
    assert.equal(dbApi.listEvents(missionId).filter((e) => e.type === 'backend_switch').length, 0);
    // The refused turn was persisted before the quota error surfaced: its files
    // must not stay behind, announced to nobody.
    const missionFolder = join(chatAttachmentsRoot(), missionId);
    assert.deepEqual(existsSync(missionFolder) ? readdirSync(missionFolder) : [], [], 'no orphan file of the refused turn');

    // Without files, the same fallback takes the turn.
    const switched = await post(`/api/agents/${missionId}/send`, { input: 'Plain question.' });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal((switched.body.switched as { backend?: string } | undefined)?.backend, FALLBACK);
  } finally {
    host.spawn = original;
    for (const backend of backendNames()) clearBackendCooldown(backend);
    if (missionId) killAgent(missionId, { source: 'test' });
    for (const dispose of disposers.reverse()) dispose();
  }
});
