/**
 * Designating an existing orchestrator as the main one. The wake recaps follow
 * `mainAgentName()`; with `_main` still on disk and nothing recorded they went
 * to `_main`, never to the orchestrator the user actually talks to.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { AGENTS_DIR, TIMON_HOME } = await import('./paths.js');
await import('../tests/helpers/claude-provider.js');

const { CONFIG_FILE } = await import('./config/load.js');
const { dbApi } = await import('./db.js');
const { seedDefaultAgent, upsertAgent } = await import('./agent.js');
const { MAIN_AGENT_KEY, chooseMainAgent, mainAgentName } = await import('./main-agent.js');

function reset() {
  rmSync(AGENTS_DIR, { force: true, recursive: true });
  rmSync(CONFIG_FILE, { force: true });
  dbApi.deleteSetting(MAIN_AGENT_KEY);
  for (const w of dbApi.listWorkspaceRows()) dbApi.deleteWorkspace(w.slug, []);
  seedDefaultAgent();
  writeFileSync(CONFIG_FILE, JSON.stringify({ workspacesRoot: join(TIMON_HOME, 'workspace') }));
}

function orchestrator(name: string, extra: Record<string, unknown> = {}) {
  upsertAgent({ name, system_prompt: 'x', config: { role: 'orchestrator', cwd: TIMON_HOME, ...extra } });
}

test('a hand-made orchestrator takes the seat from the seeded _main', () => {
  reset();
  orchestrator('alice.main');
  assert.equal(mainAgentName(), '_main', 'nothing recorded: the seed wins');

  assert.deepEqual(chooseMainAgent('alice.main'), { ok: true, name: 'alice.main' });
  assert.equal(mainAgentName(), 'alice.main');
});

test('the recorded name is the on-disk spelling, whatever case was asked', () => {
  reset();
  orchestrator('Alice');
  assert.deepEqual(chooseMainAgent('alice'), { ok: true, name: 'Alice' });
  assert.equal(mainAgentName(), 'Alice');
});

test('refuses an agent that does not exist, is not an orchestrator or belongs to a project', () => {
  reset();
  upsertAgent({ name: 'worker', system_prompt: 'x', config: { role: 'code', cwd: TIMON_HOME } });
  orchestrator('acme.main', { project: 'acme' });

  for (const name of ['ghost', 'worker', 'acme.main']) {
    const out = chooseMainAgent(name);
    assert.equal(out.ok, false, name);
  }
  assert.equal(mainAgentName(), '_main', 'a refusal records nothing');
});

test('the role fallback ignores the workspace hubs _main.<ws> (TIM-0079)', () => {
  reset();
  // Renamed by hand, nothing recorded: neither seed name is left on disk.
  rmSync(join(AGENTS_DIR, '_main'), { force: true, recursive: true });
  orchestrator('Nova');
  orchestrator('_main.perso');
  assert.equal(mainAgentName(), 'Nova', 'a hub is not a second candidate');

  // Two real project-less orchestrators stay ambiguous: no guess.
  orchestrator('Atlas');
  assert.equal(mainAgentName(), null);
});

test('the role fallback ignores a pole lead named anything else (#594)', () => {
  reset();
  rmSync(join(AGENTS_DIR, '_main'), { force: true, recursive: true });
  orchestrator('Nova');
  orchestrator('Pierre');
  // Two project-less orchestrators, nothing recorded: no guess.
  assert.equal(mainAgentName(), null);

  // Pierre leads a pole: he orchestrates its projects, not the install, and
  // must not take the seat that receives every cross-project recap. The
  // lead is compared in any case, as the hub prefix is.
  dbApi.insertWorkspace({ slug: 'agence', name: 'Agence', color: null, lead_agent: 'pierre' });
  assert.equal(mainAgentName(), 'Nova', 'a pole lead is not a second candidate');

  // A hub in another case is a hub all the same.
  orchestrator('_MAIN.perso');
  assert.equal(mainAgentName(), 'Nova');

  // Two orchestrators outside the poles stay ambiguous.
  orchestrator('Atlas');
  assert.equal(mainAgentName(), null);
});

test('a pole lead that is the only orchestrator left keeps the seat (#594)', () => {
  reset();
  rmSync(join(AGENTS_DIR, '_main'), { force: true, recursive: true });
  orchestrator('Nova');
  dbApi.insertWorkspace({ slug: 'agence', name: 'Agence', color: null, lead_agent: 'Nova' });
  assert.equal(mainAgentName(), 'Nova');

  // Two pole leads and nobody else: no guess.
  orchestrator('Pierre');
  dbApi.insertWorkspace({ slug: 'perso', name: 'Perso', color: null, lead_agent: 'Pierre' });
  assert.equal(mainAgentName(), null);
});

test('a recorded name in another case resolves to the directory spelling (TIM-0079)', async () => {
  reset();
  orchestrator('Nova');
  dbApi.setSetting(MAIN_AGENT_KEY, 'nova');
  // GET /api/agents flags `main: a.name === mainAgentName()`: the spelling as
  // recorded flagged nobody, and the app found no main agent.
  assert.equal(mainAgentName(), 'Nova');
  const { listAgents } = await import('./agent.js');
  assert.deepEqual(listAgents().filter((a) => a.name === mainAgentName()).map((a) => a.name), ['Nova']);
});

test('the legacy literal TIMON.main never answers for a project orchestrator timon.main', () => {
  reset();
  rmSync(join(AGENTS_DIR, '_main'), { force: true, recursive: true });
  orchestrator('timon.main', { project: 'timon' });
  assert.equal(mainAgentName(), null);
});
