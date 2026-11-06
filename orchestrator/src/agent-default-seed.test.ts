/**
 * The seed: a fresh install is written ONE agent, `_main`, the technical
 * orchestrator that onboarding has its owner name. The product never writes an
 * agent that belongs to anyone — no persona, no personal assistant. Renaming or
 * deleting the seed is permanent: `seedDefaultAgent` does not put it back as
 * long as any agent remains. The kernel plans without a fiber that could stay
 * PENDING and exit the daemon with code 2.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

const {
  seedDefaultAgent, deleteAgent, renameAgent, getAgent, upsertAgent, listAgents,
} = await import('./agent.js');
const { AGENTS_DIR, TIMON_HOME } = await import('./paths.js');
// Legacy configured installs keep their previous stock-agent behavior.
writeFileSync(`${TIMON_HOME}/timon.config.json`, '{}');
const { CATALOG } = await import('./kernel/catalog.js');
const { planEntries, toLoaderEntries } = await import('./kernel/registry.js');
const { config } = await import('./config/load.js');
const { getHost } = await import('./host/index.js');

function emptyAgents(): void {
  if (!existsSync(AGENTS_DIR)) return;
  for (const name of readdirSync(AGENTS_DIR)) {
    const full = `${AGENTS_DIR}/${name}`;
    if (statSync(full).isDirectory()) rmSync(full, { recursive: true, force: true });
  }
}

{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('a fresh install is seeded _main and no other agent', () => {
  emptyAgents();
  seedDefaultAgent();
  assert.ok(getAgent('_main'), '_main is the technical orchestrator');
  assert.deepEqual(listAgents().map((agent) => agent.name), ['_main'], 'nothing else is written by the product');
  // A second boot does not overwrite a customisation.
  upsertAgent({ name: '_main', system_prompt: '# customised\n' });
  seedDefaultAgent();
  assert.match(getAgent('_main')?.system_prompt ?? '', /customised/);
});

test('the seed migrates from implicit Claude to the only installed backend', () => {
  const host = getHost();
  const originalBin = host.bin;
  try {
    host.bin = ((name: string) => {
      if (name === 'codex') return '/Applications/ChatGPT.app/Contents/Resources/codex';
      throw new Error(`${name} absent`);
    }) as typeof host.bin;
    emptyAgents();
    // A file produced by an older release, before backend-aware seeding.
    upsertAgent({ name: '_main', system_prompt: 'stock', config: { model: 'sonnet', permission_mode: 'auto' } });
    // An agent of the user's, with an explicit choice: never migrated.
    upsertAgent({ name: 'alice.main', system_prompt: 'mine', config: { backend: 'claude', model: 'sonnet' } });

    seedDefaultAgent();

    assert.equal(getAgent('_main')?.backend, 'codex');
    assert.equal(getAgent('_main')?.model, 'gpt-5.6-sol');
    assert.equal(getAgent('alice.main')?.backend, 'claude', 'an explicit choice is never migrated');
  } finally {
    host.bin = originalBin;
  }
});

test('deleting the seed is permanent: seedDefaultAgent does not resurrect it', () => {
  emptyAgents();
  seedDefaultAgent();
  upsertAgent({ name: 'alice.main', system_prompt: 'mine' });
  assert.equal(deleteAgent('_main'), true);
  seedDefaultAgent();
  assert.equal(getAgent('_main'), null, 'deleted, and it stays deleted');
  assert.ok(getAgent('alice.main'), 'the rest of the product still has agents');
});

test('renaming the seed leaves an ordinary agent under the new name', () => {
  emptyAgents();
  seedDefaultAgent();
  const renamed = renameAgent('_main', 'alice.main');
  assert.equal(renamed.ok, true);
  assert.equal(getAgent('_main'), null);
  assert.ok(getAgent('alice.main'));
  seedDefaultAgent();
  assert.equal(getAgent('_main'), null, 'rename is not undone by a later seed');
  assert.ok(getAgent('alice.main'));
});

test('the kernel plans with no removed module: nothing left PENDING', () => {
  assert.equal(CATALOG.some((m) => m.id === '@timon/backlog'), false);
  const decisions = planEntries(CATALOG, {
    config: config(),
    capabilities: ['systemd', 'containers', 'traefik', 'git', 'grepai', 'uvx', 'gui'],
    licensed: CATALOG.filter((m) => m.licensed).map((m) => m.id),
  });
  assert.equal(decisions.some((d) => d.id === '@timon/backlog'), false);
  const entries = toLoaderEntries(decisions);
  assert.equal(entries.some((e) => e.id === '@timon/backlog'), false);
  // Agents still load.
  const agents = entries.find((e) => e.id === '@timon/agents');
  assert.equal(agents?.disabled, undefined);
});
