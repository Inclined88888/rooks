import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { AGENTS_DIR, TIMON_HOME, PROJECTS_DIR } = await import('./paths.js');
const { CONFIG_FILE } = await import('./config/load.js');
const { db, dbApi } = await import('./db.js');
const { seedDefaultAgent } = await import('./agent.js');
const { TEAM_STATE_KEY, readTeamState, writeTeamState, teamOnboardingPending } = await import('./onboarding-team-state.js');
const { MAIN_AGENT_STEP_KEY } = await import('./onboarding-main-agent.js');
const { existingInstance, resumeExistingInstance, ResumeError } = await import('./onboarding-resume.js');

// The daemon seeds `_main` once the release providers have registered (`whenProvidersLoaded`): mounted
// here the same way, so the seed finds its default backend without a CLI on the PATH.
{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

function reset() {
  for (const path of [AGENTS_DIR, PROJECTS_DIR, CONFIG_FILE]) rmSync(path, { force: true, recursive: true });
  db.prepare('DELETE FROM projects').run();
  dbApi.deleteSetting(TEAM_STATE_KEY);
  dbApi.deleteSetting(MAIN_AGENT_STEP_KEY);
}

test('a home holding only what the product seeded has nothing to resume', () => {
  reset();
  seedDefaultAgent();
  assert.equal(existingInstance().present, false);
  assert.throws(() => resumeExistingInstance(), /nothing_to_resume/);
  assert.equal(existsSync(CONFIG_FILE), false);
});

test('an agent of the user\'s own makes the instance resumable', () => {
  reset();
  seedDefaultAgent();
  mkdirSync(join(AGENTS_DIR, 'mine'), { recursive: true });
  writeFileSync(join(AGENTS_DIR, 'mine', 'system-prompt.md'), 'Keep me');
  const found = existingInstance();
  assert.equal(found.present, true);
  assert.equal(found.agents, 1);

  writeTeamState({ status: 'pending' });
  const written = resumeExistingInstance();

  // The config that was missing is written, and only it.
  assert.equal(JSON.parse(readFileSync(written.path, 'utf8')).workspacesRoot, undefined);
  assert.equal(readFileSync(join(AGENTS_DIR, 'mine', 'system-prompt.md'), 'utf8'), 'Keep me');
  // The remaining steps no longer send this user back into the wizard.
  assert.equal(dbApi.getAllSettings()[MAIN_AGENT_STEP_KEY], 'complete');
  assert.equal(readTeamState()?.status, 'complete');
  assert.equal(teamOnboardingPending(), false);

  // Resuming twice is not a way to flatten a configuration.
  assert.throws(() => resumeExistingInstance(), /setup_complete/);
});

test('a project alone is enough, and ResumeError is what the route maps to 409', () => {
  reset();
  seedDefaultAgent();
  mkdirSync(join(PROJECTS_DIR, 'acme'), { recursive: true });
  db.prepare('INSERT INTO projects (slug, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('acme', 'Acme', Date.now(), Date.now());
  assert.equal(existingInstance().projects, 1);
  assert.equal(existingInstance().present, true);
  try {
    resumeExistingInstance();
    resumeExistingInstance();
    assert.fail('the second call must refuse');
  } catch (error) {
    assert.ok(error instanceof ResumeError);
  }
});

test('#120: the wizard is offered the projects folder the last update saved', async () => {
  reset();
  const { previousWorkspacesRoot } = await import('./onboarding-resume.js');
  const root = join(TIMON_HOME, 'my-projects');
  mkdirSync(root, { recursive: true });
  const saved = join(TIMON_HOME, 'backups', 'pre-0.1.1');
  mkdirSync(saved, { recursive: true });
  writeFileSync(join(saved, 'timon.config.json'), JSON.stringify({ workspacesRoot: root }));
  assert.equal(previousWorkspacesRoot(), root);
  assert.equal(existingInstance().workspacesRoot, root);
  rmSync(join(TIMON_HOME, 'backups'), { recursive: true, force: true });
});

test('#120: without a saved configuration, the folder holding the projects is offered', async () => {
  reset();
  const { previousWorkspacesRoot, commonParent } = await import('./onboarding-resume.js');
  const root = join(TIMON_HOME, 'work');
  for (const slug of ['alpha', 'beta']) mkdirSync(join(root, slug), { recursive: true });
  dbApi.upsertProject('alpha', { cwd: join(root, 'alpha') });
  dbApi.upsertProject('beta', { cwd: join(root, 'beta') });
  assert.equal(previousWorkspacesRoot(), root);
  assert.equal(commonParent([join(root, 'alpha', 'deep'), join(root, 'beta')]), root);
  assert.equal(commonParent([]), null);
  reset();
  assert.equal(previousWorkspacesRoot(), null);
});
