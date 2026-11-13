/**
 * Onboarding step 3 — the user names the orchestrator they will talk to.
 *
 * What is protected here, in order of risk:
 *   1. the rename is a REAL rename, and the fallbacks follow it. Three code
 *      paths (dispatcher recaps, notifications, wake digests) used to address
 *      the literal `_main`; after a rename that name is a directory that no
 *      longer exists, and a notification written to it is a notification
 *      nobody reads.
 *   2. `system-prompt.md` survives. The identity goes to `SOUL.md`; the
 *      technical instructions the orchestrator needs are not a personality's
 *      to overwrite.
 *   3. a name a human types ("Rooks, mon assistante") becomes a valid agent
 *      name instead of a rejection.
 */
import './test-home.js';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { AGENTS_DIR, ROOKS_HOME, DB_PATH, agentDir } = await import('./paths.js');
await import('../tests/helpers/claude-provider.js');

const { CONFIG_FILE } = await import('./config/load.js');
const { db, dbApi } = await import('./db.js');
const { getAgent, seedDefaultAgent, upsertAgent, patchAgentConfig } = await import('./agent.js');
const { TEAM_STATE_KEY } = await import('./onboarding-team-state.js');
const { MAIN_AGENT_KEY, mainAgentName } = await import('./main-agent.js');
const {
  MAIN_AGENT_NAMED_KEY, MAIN_AGENT_STEP_KEY, applyMainAgent, applyMainAgentName, mainAgentOnboardingPending, mainAgentStatus,
  skipMainAgent, toAgentName,
} = await import('./onboarding-main-agent.js');

function reset() {
  rmSync(AGENTS_DIR, { force: true, recursive: true });
  rmSync(CONFIG_FILE, { force: true });
  for (const key of [TEAM_STATE_KEY, MAIN_AGENT_STEP_KEY, MAIN_AGENT_KEY, MAIN_AGENT_NAMED_KEY]) dbApi.deleteSetting(key);
  seedDefaultAgent();
  writeFileSync(CONFIG_FILE, JSON.stringify({ workspacesRoot: join(ROOKS_HOME, 'workspace') }));
}

/**
 * The cockpit of a fresh install opens on a chat with the agent its owner
 * just named. That card is a layout row (`agent-chat`, an UNHASHED scope), so
 * the daemon can seed it once for the whole machine under `owner=''` — which
 * is the only place the chosen name is known at that moment.
 */
test('step 3 seeds the cockpit card with the agent that was just named', () => {
  reset();
  dbApi.uiLayoutDelete('', 'agent-chat');

  applyMainAgent({ name: 'Rooks', avatarUrl: '/api/uploads/avatars/n.png' });

  const row = dbApi.uiLayoutGet('', 'agent-chat');
  assert.ok(row, 'the machine template carries the card');
  assert.deepEqual(JSON.parse(row!.value), {
    instances: [{ id: 'main', agent: 'Rooks', title: 'Rooks', avatar: '/api/uploads/avatars/n.png', zone: 'centre', subAgents: [] }],
  });

  // Skipping names nothing, but the centre still opens on a conversation:
  // the orchestrator as it stands, placeholder included.
  reset();
  dbApi.uiLayoutDelete('', 'agent-chat');
  skipMainAgent();
  const skipped = JSON.parse(dbApi.uiLayoutGet('', 'agent-chat')!.value) as { instances: { agent: string }[] };
  assert.equal(skipped.instances[0]?.agent, '_main');
});

test('a typed display name becomes a valid agent name', () => {
  assert.equal(toAgentName('Rooks'), 'Rooks');
  assert.equal(toAgentName('Rooks, mon assistante'), 'Rooks-mon-assistante');
  assert.equal(toAgentName('  Éléa  '), 'Elea');
  assert.equal(toAgentName('***'), '', 'nothing usable left is an empty name, not a bad one');
});

test('the step renames the orchestrator, writes SOUL.md and keeps the system prompt', () => {
  reset();
  assert.equal(mainAgentOnboardingPending(), true);
  const seeded = readFileSync(join(agentDir('_main'), 'system-prompt.md'), 'utf8');

  const status = applyMainAgent({
    name: 'Rooks',
    objective: 'Run my week.',
    soul: 'Direct, never chatty.',
    avatarUrl: '/api/uploads/projects/abc.png',
  });

  assert.equal(status.name, 'Rooks');
  assert.equal(existsSync(agentDir('_main')), false, 'renamed, not cloned');
  assert.equal(mainAgentName(), 'Rooks', 'the fallbacks now resolve to the new name');

  const soul = readFileSync(join(agentDir('Rooks'), 'SOUL.md'), 'utf8');
  assert.match(soul, /Run my week\./);
  assert.match(soul, /Direct, never chatty\./);
  assert.equal(readFileSync(join(agentDir('Rooks'), 'system-prompt.md'), 'utf8'), seeded);

  const agent = getAgent('Rooks');
  assert.equal(agent?.icon_url, '/api/uploads/projects/abc.png');
  assert.equal(agent?.role, 'orchestrator');
  assert.equal(mainAgentOnboardingPending(), false, 'the step does not come back');
});

test('an avatar must come from this daemon, and a taken name is refused', () => {
  reset();
  assert.throws(
    () => applyMainAgent({ name: 'Rooks', avatarUrl: 'https://evil.example/pixel.png' }),
    /invalid_avatar/,
  );
  assert.throws(
    () => applyMainAgent({ name: 'Rooks', avatarUrl: '/api/uploads/avatars/../../etc/passwd' }),
    /invalid_avatar/,
  );
  assert.equal(mainAgentOnboardingPending(), true, 'a refusal does not close the step');

  upsertAgent({ name: 'Taken', system_prompt: 'x', config: {} });
  assert.throws(() => applyMainAgent({ name: 'Taken' }), /name_taken/);
  assert.throws(() => applyMainAgent({ name: '***' }), /invalid_name/);
  assert.equal(mainAgentName(), '_main', 'nothing moved');
});

test('skipping keeps the seeded agent and closes the step', () => {
  reset();
  const status = skipMainAgent();
  assert.equal(status.name, '_main');
  assert.equal(mainAgentOnboardingPending(), false);
  assert.equal(mainAgentStatus().status, 'complete');
});

/**
 * « Skip » is now on every screen of the step, so the route behind it is worth
 * a refusal test: an anonymous caller or a restricted token must not be able to
 * close someone else's onboarding — and the refusal must leave the step open.
 */
test('skipping over HTTP is refused to an anonymous caller and a restricted token, and changes nothing', async () => {
  reset();
  dbApi.setSetting(TEAM_STATE_KEY, JSON.stringify({ status: 'pending' }));
  assert.equal(mainAgentOnboardingPending(), true);
  const { default: express } = await import('express');
  const { registerRoutes } = await import('./plugins-bundled/http/routes.js');
  const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: 'test-operator', required: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-test-restricted']) req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: [] };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/setup/main-agent`;
  const body = JSON.stringify({ skip: true });
  // A setup conversation still running, and an unrelated mission that must survive the skip.
  const { SETUP_CHANNEL } = await import('./onboarding-main-agent-chat.js');
  dbApi.createMission('skip-setup-chat', '_main', 'setup', { channel: SETUP_CHANNEL });
  dbApi.createMission('skip-plain', '_main', 'hello');
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 401);
    assert.equal((await fetch(url, {
      method: 'POST', headers: { authorization: 'Bearer test-operator', 'content-type': 'application/json', 'x-test-restricted': '1' }, body,
    })).status, 403);
    assert.equal(mainAgentOnboardingPending(), true, 'a refused skip leaves the step open');
    assert.notEqual(dbApi.getAllSettings()[MAIN_AGENT_STEP_KEY], 'complete');
    assert.equal(dbApi.getMission('skip-setup-chat')?.status, 'running', 'a refused skip stops nothing');

    const ok = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer test-operator', 'content-type': 'application/json' }, body });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { status?: string }).status, 'complete');
    assert.equal(mainAgentOnboardingPending(), false);
    // Its tools now refuse: the setup conversation is ended, not left to the reaper.
    assert.notEqual(dbApi.getMission('skip-setup-chat')?.status, 'running');
    assert.equal(dbApi.getMission('skip-plain')?.status, 'running', 'only the setup conversation is stopped');
  } finally {
    server.close();
    // A mission on record makes the install look used, and the next `reset()` would not reopen the step.
    db.prepare(`DELETE FROM missions WHERE id IN ('skip-setup-chat', 'skip-plain')`).run();
  }
});

test('a second daemon cannot put the placeholder back after the rename', async () => {
  // The packaged Windows case: two daemons on one home during the first launch.
  // The second one boots late, lists an AGENTS_DIR that no longer holds `_main`
  // — because step 3 renamed it — and used to seed it again, which is how a
  // fresh install ended up with `_main` in the middle of its canvas and the
  // agent its owner had just named sitting beside it.
  const { rmSync, readdirSync } = await import('node:fs');
  const { seedDefaultAgent } = await import('./agent.js');
  const { AGENTS_DIR } = await import('./paths.js');
  const { MAIN_AGENT_KEY } = await import('./main-agent.js');
  const { dbApi } = await import('./db.js');

  rmSync(AGENTS_DIR, { recursive: true, force: true });
  dbApi.deleteSetting(MAIN_AGENT_KEY);
  seedDefaultAgent();
  assert.ok(readdirSync(AGENTS_DIR).includes('_main'));

  // Step 3, then the stale daemon finishing its own boot.
  applyMainAgent({ name: 'Rooks' });
  assert.equal(readdirSync(AGENTS_DIR).includes('_main'), false);
  seedDefaultAgent();
  assert.deepEqual(readdirSync(AGENTS_DIR).sort(), ['Rooks']);

  // And a home emptied BY HAND is not that race: the recorded name points at
  // nothing, so the install is back to being a fresh one and gets its seed.
  rmSync(AGENTS_DIR, { recursive: true, force: true });
  seedDefaultAgent();
  assert.ok(readdirSync(AGENTS_DIR).includes('_main'), 'a wiped home is seedable again');
});


test('a locked Windows directory leaves setup pending and can be retried', (t) => {
  reset();
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => applyMainAgent({ name: 'Rooks' }), /rename_failed/);
    assert.equal(mainAgentName(), '_main');
    assert.equal(existsSync(agentDir('Rooks')), false);
    assert.equal(mainAgentOnboardingPending(), true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(applyMainAgent({ name: 'Rooks' }).name, 'Rooks');
});

test('a database failure rolls the directory rename back', (t) => {
  reset();
  t.mock.method(dbApi, 'renameAgentRefs', () => { throw new Error('database failure'); });
  assert.throws(() => applyMainAgent({ name: 'Rooks' }), /database failure/);
  assert.equal(mainAgentName(), '_main');
  assert.equal(existsSync(agentDir('Rooks')), false);
  assert.equal(mainAgentOnboardingPending(), true);
});

test('seeding holds the cross-daemon write lock before discovering the backend', async (t) => {
  reset();
  const { getHost } = await import('./host/index.js');
  const second = new Database(DB_PATH, { timeout: 0 });
  let locked = false;
  t.mock.method(getHost(), 'bin', () => {
    try {
      second.exec('BEGIN IMMEDIATE');
      second.exec('ROLLBACK');
    } catch (error) { locked = (error as { code?: string }).code === 'SQLITE_BUSY'; }
    throw new Error('binary unavailable');
  });
  try {
    seedDefaultAgent();
    assert.equal(locked, true);
  } finally { second.close(); }
});

test('setup creates the saved workspace and preserves an existing cwd', () => {
  reset();
  const workspace = join(ROOKS_HOME, 'new-workspace');
  writeFileSync(CONFIG_FILE, JSON.stringify({ workspacesRoot: workspace }));
  applyMainAgent({ name: 'Rooks' });
  assert.equal(getAgent('Rooks')?.cwd, fs.realpathSync(workspace));
  const custom = join(ROOKS_HOME, 'custom');
  patchAgentConfig('Rooks', { cwd: custom });
  writeFileSync(CONFIG_FILE, JSON.stringify({ workspacesRoot: 'relative-invalid' }));
  applyMainAgent({ name: 'Rooks' });
  assert.equal(getAgent('Rooks')?.cwd, custom);
});

test('without a workspacesRoot the agent works in the Rooks home, never the user home', () => {
  reset();
  writeFileSync(CONFIG_FILE, JSON.stringify({}));
  applyMainAgent({ name: 'Rooks' });
  const cwd = getAgent('Rooks')?.cwd;
  assert.equal(cwd, fs.realpathSync(join(ROOKS_HOME, 'workspace')));
  assert.notEqual(cwd, os.homedir());
});

test('an unreadable config file is workspace_unavailable, and nothing moves', () => {
  reset();
  writeFileSync(CONFIG_FILE, '{ "workspacesRoot": ');
  assert.throws(() => applyMainAgent({ name: 'Rooks' }), /workspace_unavailable/);
  assert.equal(mainAgentName(), '_main');
  assert.equal(mainAgentOnboardingPending(), true);
});

test('an invalid workspace does not rename or complete the step', () => {
  reset();
  writeFileSync(CONFIG_FILE, JSON.stringify({ workspacesRoot: 'relative-invalid' }));
  assert.throws(() => applyMainAgent({ name: 'Rooks' }), /workspace_unavailable/);
  assert.equal(mainAgentName(), '_main');
  assert.equal(mainAgentOnboardingPending(), true);
});


test('renaming holds the same lock and records the new identity before releasing it', (t) => {
  reset();
  const second = new Database(DB_PATH, { timeout: 0 });
  const move = fs.renameSync;
  let locked = false;
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    try {
      second.exec('BEGIN IMMEDIATE');
      second.exec('ROLLBACK');
    } catch (error) { locked = (error as { code?: string }).code === 'SQLITE_BUSY'; }
    return move(...args);
  });
  syncBuiltinESMExports();
  try {
    applyMainAgent({ name: 'Rooks' });
    assert.equal(locked, true);
    const row = second.prepare('SELECT value FROM settings WHERE key = ?').get(MAIN_AGENT_KEY) as { value: string };
    assert.equal(row.value, 'Rooks');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    second.close();
  }
});


test('setup expands home workspace paths inside an isolated home', (t) => {
  reset();
  const home = join(ROOKS_HOME, 'user-home');
  t.mock.method(os, 'homedir', () => home);
  syncBuiltinESMExports();
  try {
    for (const root of ['~', '~/nested']) {
      reset();
      writeFileSync(CONFIG_FILE, JSON.stringify({ workspacesRoot: root }));
      applyMainAgent({ name: 'Rooks' });
      assert.equal(getAgent('Rooks')?.cwd, fs.realpathSync(root === '~' ? home : join(home, 'nested')));
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('the renamed agent no longer calls itself _main', () => {
  reset();
  const file = join(agentDir('_main'), 'system-prompt.md');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /_main/, 'a fresh seed names nobody');
  // A prompt seeded by an older build still opens on the seed's name.
  writeFileSync(file, 'You are _main, the orchestrator of a personal agentic OS (ROOKS).\nBe concise.\n');
  applyMainAgent({ name: 'Sonic' });
  assert.equal(readFileSync(join(agentDir('Sonic'), 'system-prompt.md'), 'utf8'),
    'You are Sonic, the orchestrator of a personal agentic OS (ROOKS).\nBe concise.\n');
});

test('whether the name was given is said by the status, never read from the agent\'s name', () => {
  reset();
  // An orchestrator of any name, found by its role: nothing recorded, so the name step is still ahead.
  rmSync(agentDir('_main'), { force: true, recursive: true });
  upsertAgent({ name: 'Rooks', system_prompt: 'x', config: {} });
  patchAgentConfig('Rooks', { role: 'orchestrator' });
  assert.equal(mainAgentName(), 'Rooks');
  const before = mainAgentStatus();
  assert.equal(before.name, 'Rooks');
  assert.equal(before.named, false, 'a name that is not `_main` does not mean the step is behind');

  assert.equal(applyMainAgentName('Rooks'), 'Rooks');
  assert.equal(mainAgentStatus().named, true);
  assert.equal(dbApi.getAllSettings()[MAIN_AGENT_NAMED_KEY], '1');

  // The seed itself, named `_main` on purpose by the person: the step is behind all the same.
  reset();
  assert.equal(mainAgentStatus().named, false);
  applyMainAgentName('_main');
  assert.deepEqual([mainAgentStatus().name, mainAgentStatus().named], ['_main', true]);

  // Named on a build before the marker: the recorded seat says so.
  reset();
  dbApi.setSetting(MAIN_AGENT_KEY, '_main');
  assert.equal(mainAgentStatus().named, true);
});
