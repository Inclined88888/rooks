/**
 * `agents:privileged-config`: the power-user path of the override guards.
 * Without it the conservative rules stand; with it any known mode/backend/tool
 * passes, bounded by the caller's own permission level.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-privconf-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { agentConfigRefusal, llmChoiceRefusal, spawnOverrideRefusal, taskOverrideRefusal, RESTRICTED } = await import('./privileged-overrides.js');
const { MISSION_TOKEN_PERMISSIONS } = await import('./permissions.js');
const { catalogBackend } = await import('../backends/catalog.js');


{
  const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

const relaxed = (ceiling: string | null) => ({ relaxed: true, ceiling });
const sandbox = ['codex', 'grok', 'copilot'].find((id) => catalogBackend(id)?.permissionModel === 'sandbox');

test('the mission token cap carries the permission', () => {
  assert.ok((MISSION_TOKEN_PERMISSIONS as readonly string[]).includes('agents:privileged-config'));
});

test('restricted: bypassPermissions, a sandbox backend and new tools stay refused', () => {
  assert.match(agentConfigRefusal({ permission_mode: 'bypassPermissions' }, null, RESTRICTED) ?? '', /not allowed/);
  assert.ok(sandbox, 'the catalogue must hold a sandbox backend');
  assert.match(agentConfigRefusal({ backend: sandbox }, null, RESTRICTED) ?? '', /cannot arbitrate/);
  assert.match(agentConfigRefusal({ allowed_tools: ['Bash'] }, null, RESTRICTED) ?? '', /widens/);
});

test('relaxed: a sandbox backend and free tools pass', () => {
  assert.equal(agentConfigRefusal({ backend: sandbox, allowed_tools: ['Bash'], mcp_servers: ['x'] }, null, relaxed('default')), null);
});

test('relaxed: the level never exceeds the caller\'s own', () => {
  assert.equal(agentConfigRefusal({ permission_mode: 'acceptEdits' }, null, relaxed('auto')), null);
  assert.equal(agentConfigRefusal({ permission_mode: 'auto' }, null, relaxed('auto')), null);
  assert.match(agentConfigRefusal({ permission_mode: 'auto' }, null, relaxed('default')) ?? '', /above the caller's own level/);
  assert.match(agentConfigRefusal({ permission_mode: 'bypassPermissions' }, null, relaxed('acceptEdits')) ?? '', /above/);
});

test('relaxed: the codex sandbox names share the ladder with the claude modes', () => {
  const ask = (mode: string, ceiling: string | null) => agentConfigRefusal({ permission_mode: mode }, null, relaxed(ceiling));
  assert.equal(ask('read-only', 'plan'), null);
  assert.equal(ask('plan', 'read-only'), null);
  assert.equal(ask('workspace-write', 'auto'), null);
  assert.equal(ask('auto', 'workspace-write'), null);
  assert.equal(ask('danger-full-access', 'bypassPermissions'), null);
  assert.equal(ask('bypassPermissions', 'danger-full-access'), null);
  assert.match(ask('workspace-write', 'acceptEdits') ?? '', /above/);
  assert.match(ask('workspace-write', 'read-only') ?? '', /above/);
  assert.match(ask('danger-full-access', 'workspace-write') ?? '', /above/);
  assert.match(ask('workspace_write', 'workspace-write') ?? '', /not a known permission mode/);
});

test('a value the agent already holds is never refused, whatever the caller may pick', () => {
  const current = { backend: sandbox, model: 'unlisted-model', permission_mode: 'danger-full-access', cwd: process.cwd() };
  // The whole current config sent back, from the weakest caller there is.
  assert.equal(agentConfigRefusal({ ...current }, current, RESTRICTED), null);
  assert.equal(agentConfigRefusal({ ...current }, current, relaxed('plan')), null);
  // One changed field is judged on its own.
  assert.match(agentConfigRefusal({ ...current, permission_mode: 'acceptEdits' }, current, relaxed('plan')) ?? '', /above/);
  // The same level under its other name is not a change either.
  assert.equal(agentConfigRefusal({ ...current, permission_mode: 'bypassPermissions' }, current, relaxed('plan')), null);
  assert.match(agentConfigRefusal({ ...current, model: 'other-unlisted' }, current, RESTRICTED) ?? '', /catalogue/);
  assert.match(agentConfigRefusal({ ...current, cwd: '/' }, current, RESTRICTED) ?? '', /register the project first/i);
});

test('relaxed: an agent already in bypassPermissions may pass it on', () => {
  assert.equal(agentConfigRefusal({ permission_mode: 'bypassPermissions' }, null, relaxed('bypassPermissions')), null);
});

test('relaxed: no mission behind the call (human) means no ceiling, but a typo is refused', () => {
  assert.equal(agentConfigRefusal({ permission_mode: 'bypassPermissions' }, null, relaxed(null)), null);
  assert.match(agentConfigRefusal({ permission_mode: 'byPassPermission' }, null, relaxed(null)) ?? '', /not a known permission mode/);
});

test('relaxed: an unknown ceiling hands nothing out', () => {
  assert.match(agentConfigRefusal({ permission_mode: 'default' }, null, relaxed('weird')) ?? '', /above/);
});

test('tasks take the spawn rules', () => {
  const bypass = { permission_mode_override: 'bypassPermissions' };
  assert.match(taskOverrideRefusal(bypass, null, RESTRICTED) ?? '', /not allowed/);
  assert.match(taskOverrideRefusal(bypass, null, relaxed('default')) ?? '', /above/);
  assert.equal(taskOverrideRefusal(bypass, null, relaxed('bypassPermissions')), null);
  assert.match(taskOverrideRefusal({ backend_override: sandbox }, null, RESTRICTED) ?? '', /cannot arbitrate/);
  assert.equal(taskOverrideRefusal({ backend_override: sandbox }, null, relaxed('default')), null);
  assert.equal(taskOverrideRefusal({ permission_mode_override: null, backend_override: null }, null, RESTRICTED), null);
});

test('spawn: relaxed lifts the tool and sandbox rules, keeps the ceiling', () => {
  assert.match(spawnOverrideRefusal({ extra_allowed_tools: ['Bash'] }, null, RESTRICTED) ?? '', /widens/);
  assert.equal(spawnOverrideRefusal({ extra_allowed_tools: ['Bash'], backend_override: sandbox }, null, relaxed('default')), null);
  assert.match(spawnOverrideRefusal({ permission_mode: 'bypassPermissions' }, null, relaxed('default')) ?? '', /above/);
});

test('restricted: a remote backend is selectable — it starts nothing on this host — a local sandbox still is not', async () => {
  const { registerDialect, registerProfile } = await import('../backends/registry.js');
  const { memoryDialect } = await import('../../tests/helpers/example-dialects.js') as {
    memoryDialect: import('../backends/types.js').RemoteDialect;
  };
  const OWNER = 'privileged-config-remote-test';
  const offs = [
    registerDialect(OWNER, 'privileged-remote', memoryDialect),
    registerProfile(OWNER, {
      id: 'privileged-remote-gateway', dialect: 'privileged-remote', label: 'Remote gateway',
      defaultModel: null, models: [], env: {},
    }),
  ];
  try {
    assert.equal(catalogBackend('privileged-remote-gateway')?.remote, true);
    assert.equal(agentConfigRefusal({ backend: 'privileged-remote-gateway' }, null, RESTRICTED), null);
    // Nothing else is relaxed by it: the permission mode is still capped.
    assert.match(
      agentConfigRefusal({ backend: 'privileged-remote-gateway', permission_mode: 'bypassPermissions' }, null, RESTRICTED) ?? '',
      /bypassPermissions/,
    );
    // And a local backend that cannot arbitrate stays refused.
    assert.match(agentConfigRefusal({ backend: sandbox }, null, RESTRICTED) ?? '', /cannot arbitrate/);
  } finally {
    for (const off of offs) off();
  }
});

test('a backend chosen for later (fallback, series rule) takes the backend_override grid (TODO #561)', () => {
  assert.ok(sandbox);
  assert.match(llmChoiceRefusal({ backend: sandbox }, RESTRICTED, 'fallback') ?? '', /^fallback: backend .* cannot arbitrate/);
  assert.match(taskOverrideRefusal({ fallback_backend_override: sandbox }, null, RESTRICTED) ?? '', /cannot arbitrate/);
  assert.equal(llmChoiceRefusal({ backend: sandbox }, relaxed(null), 'fallback'), null);
  // Naming no backend selects none: the sentinel, null, '' and a model alone.
  for (const backend of ['none', null, '', undefined]) {
    assert.equal(llmChoiceRefusal({ backend, model: 'whatever' }, RESTRICTED, 'fallback'), null, String(backend));
  }
  assert.match(llmChoiceRefusal({ backend: 'claude', model: 'gpt-5.6-sol' }, relaxed(null), 'fallback') ?? '', /not in the catalogue/);
  assert.match(llmChoiceRefusal({ backend: 42 }, RESTRICTED, 'fallback') ?? '', /must be a string/);
});
