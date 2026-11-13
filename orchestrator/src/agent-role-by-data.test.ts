/**
 * The role of an agent is a FIELD, not a reading of its name.
 *
 * What this locks: a project whose reviewer is called `Jean-Pierre` sees its
 * `review` tasks go to Jean-Pierre. Before, the dispatcher resolved
 * `<slug>.reviewer` by convention, seeded that agent on the spot, and sent the
 * task to the empty duplicate it had just created — the named agent was never
 * addressed, and nothing said so.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';

const { upsertAgent, getAgent, listAgents, patchAgentConfig } = await import('./agent.js');
await import('../tests/helpers/claude-provider.js');

const { resolveRoleAgent } = await import('./agent-seed.js');
const { backfillAgentRoles, roleFromAgentName, ROLE_BACKFILL_KEY } = await import('./agent-role-backfill.js');
const { dbApi } = await import('./db.js');
const { AGENTS_DIR } = await import('./paths.js');

function emptyAgents(): void {
  if (!existsSync(AGENTS_DIR)) return;
  for (const name of readdirSync(AGENTS_DIR)) {
    const full = `${AGENTS_DIR}/${name}`;
    if (statSync(full).isDirectory()) rmSync(full, { recursive: true, force: true });
  }
}

test('an agent named anything holds the role, and no duplicate is seeded next to it', () => {
  emptyAgents();
  upsertAgent({
    name: 'Jean-Pierre',
    system_prompt: '# reviewer\n',
    config: { cwd: '/tmp/globex', project: 'globex', role: 'reviewer' },
  });

  const resolved = resolveRoleAgent('globex', 'reviewer', { cwd: '/tmp/globex' });

  assert.equal(resolved, 'Jean-Pierre');
  assert.equal(getAgent('globex.reviewer'), null, 'no convention agent was created');
});

test('the roles.json pin still wins over the agent that carries the role', () => {
  emptyAgents();
  upsertAgent({
    name: 'Jean-Pierre',
    system_prompt: '# reviewer\n',
    config: { cwd: '/tmp/globex', project: 'globex', role: 'reviewer' },
  });
  upsertAgent({
    name: 'Brigitte',
    system_prompt: '# reviewer\n',
    config: { cwd: '/tmp/globex', project: 'globex', role: 'reviewer' },
  });

  const pinned = resolveRoleAgent('globex', 'reviewer', { cwd: '/tmp/globex', spec: { agent: 'Brigitte' } });
  assert.equal(pinned, 'Brigitte');

  // Two holders, no pin: the choice must not flip from one dispatch to the
  // next — a pipeline would split across two agents.
  const first = resolveRoleAgent('globex', 'reviewer', { cwd: '/tmp/globex' });
  const second = resolveRoleAgent('globex', 'reviewer', { cwd: '/tmp/globex' });
  assert.equal(first, second);
});

test('a project with nobody on the role falls back to the naming default, and seeds it', () => {
  emptyAgents();
  const resolved = resolveRoleAgent('globex', 'coder', { cwd: '/tmp/globex' });

  assert.equal(resolved, 'globex.coder');
  const seeded = getAgent('globex.coder');
  assert.equal(seeded?.role, 'coder', 'the seeded agent CARRIES the role, it does not merely spell it');
  assert.match(seeded?.system_prompt ?? '', /You are `globex\.coder`/);
});

test('a pinned agent that does not exist yet is seeded under its own name, prompt included', () => {
  emptyAgents();
  const resolved = resolveRoleAgent('globex', 'merger', { cwd: '/tmp/globex', spec: { agent: 'Ginette' } });

  assert.equal(resolved, 'Ginette');
  const seeded = getAgent('Ginette');
  assert.equal(seeded?.role, 'merger');
  assert.match(seeded?.system_prompt ?? '', /You are `Ginette`/, 'the prompt calls it by its name, not by the convention');
});

test('the backfill stamps the role the old convention read, once', () => {
  emptyAgents();
  dbApi.setSetting(ROLE_BACKFILL_KEY, '');
  // Roleless on disk, as written before `upsertAgent` started stamping a
  // default: that is exactly the population the backfill exists for.
  for (const name of ['legacy.coder', 'legacy.main', 'Jean-Pierre']) {
    upsertAgent({ name, system_prompt: `# ${name}\n`, config: { cwd: '/tmp/legacy' } });
    patchAgentConfig(name, { role: undefined });
  }

  assert.equal(backfillAgentRoles(), 2, 'only the two names the convention could read');
  assert.equal(getAgent('legacy.coder')?.role, 'coder');
  assert.equal(getAgent('legacy.main')?.role, 'orchestrator', 'main is the orchestrator, under its old spelling');
  assert.equal(getAgent('Jean-Pierre')?.role, null, 'a name that says nothing stamps nothing');

  // Removing a role on purpose must survive the next boot.
  patchAgentConfig('legacy.coder', { role: undefined });
  assert.equal(backfillAgentRoles(), 0, 'the backfill never runs twice');
  assert.equal(getAgent('legacy.coder')?.role, null);
});

test('what the old convention read, for the record', () => {
  assert.equal(roleFromAgentName('globex.researcher'), 'research', 'the suffix and the role id were not spelled alike');
  assert.equal(roleFromAgentName('_main'), 'orchestrator');
  assert.equal(roleFromAgentName('_main.perso'), 'orchestrator', 'workspace hubs orchestrate too');
  assert.equal(roleFromAgentName('Jean-Pierre'), null);
  assert.ok(listAgents().length >= 0);
});
