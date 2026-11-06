/**
 * An agent with a live mission is not renamed: the process holds its name and
 * its cwd. Spawned for real on the in-memory backend of
 * `examples/plugin-remote-backend`, so the refusal is the one the route and
 * `timon agent rename` hit, not a registry poked by hand.
 */
import './test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { spawnAgent, upsertAgent, killAgent, isRunning, renameAgent } = await import('./agent.js');
const { agentDir } = await import('./paths.js');
const { dbApi } = await import('./db.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { memoryDialect } = await import('../tests/helpers/example-dialects.js') as {
  memoryDialect: import('./backends/types.js').RemoteDialect;
};

const OWNER = 'agent-rename-live-test';
const AGENT = 'busy-agent';

invalidateSettingsCache();
const disposers = [
  registerDialect(OWNER, 'memory-rename', { ...memoryDialect, id: 'memory-rename' }),
  registerProfile(OWNER, { id: 'memory-rename-quick', dialect: 'memory-rename', label: 'memory', defaultModel: null, models: [], env: {} }),
];
const missions: string[] = [];
after(() => {
  for (const id of missions) if (isRunning(id)) killAgent(id, { source: 'test' });
  for (const dispose of disposers.reverse()) dispose();
});

upsertAgent({
  name: AGENT,
  system_prompt: 'You are a witness.',
  config: { backend: 'memory-rename-quick', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
});

async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('a live mission blocks the rename and leaves everything in place', async () => {
  const missionId = await spawnAgent(AGENT, 'hello', undefined, { explicitResume: null });
  missions.push(missionId);
  assert.ok(isRunning(missionId));

  const refused = renameAgent(AGENT, 'renamed-agent');
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', /mission in progress for busy-agent/);
  assert.equal(existsSync(agentDir(AGENT)), true);
  assert.equal(existsSync(agentDir('renamed-agent')), false);
  assert.equal(dbApi.getMission(missionId)?.agent_name, AGENT);

  killAgent(missionId, { source: 'test' });
  await until(() => !isRunning(missionId) && dbApi.getMission(missionId)?.status !== 'running', 'the kill');

  assert.equal(renameAgent(AGENT, 'renamed-agent').ok, true, 'free once the mission is over');
  assert.equal(dbApi.getMission(missionId)?.agent_name, 'renamed-agent');
});
