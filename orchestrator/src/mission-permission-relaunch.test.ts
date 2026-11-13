/**
 * A persistent CLI takes its permission mode as a launch argument: a level
 * changed mid-mission (TODO #430) relaunches it on its own session before the
 * next message, without ending the mission, and only then.
 */
import './test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { Dialect, NormalizedEvent } from './backends/types.js';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const { witnessCli } = await import('../tests/helpers/witness-cli.js');
const WITNESS_CLI = witnessCli(tmpdir());

const { spawnAgent, upsertAgent, sendToAgent, killAgent, isRunning } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');

/** Each launch: the mode it was given and the session it resumed. */
const launches: Array<{ mode: string | undefined; resume: string | null }> = [];

// Answers the first message at once, then one `result` per stdin line.
const SCRIPT = `
const out = (e) => console.log(JSON.stringify(e));
const turn = () => out({ type: 'result', payload: { subtype: 'success', is_error: false, result: 'ok' } });
out({ type: 'system', payload: { subtype: 'init', session_id: 'relaunch-session' } });
turn();
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { buf = buf.slice(i + 1); turn(); } });
`;

const dialect: Dialect = {
  defaultCmd: WITNESS_CLI, persistentProcess: true, finishMissionOnExit: false,
  sessionResumable: true, sessionStore: 'global', permissionModel: 'mcp-bridge', rateLimitReporting: 'none', hostedConnectors: false,
  async buildSpawn(opts) {
    launches.push({ mode: opts.cfg.permission_mode, resume: opts.resumeSession });
    return { cmd: WITNESS_CLI, args: ['-e', SCRIPT], cwd: opts.cfg.cwd, initialStdin: null };
  },
  writeUserInput(proc, text) { proc.stdin.write(`${text.replace(/\n/g, ' ')}\n`); },
  parseLine(line) { return [JSON.parse(line) as NormalizedEvent]; },
  extractSessionId(event) { const payload = event.payload as { session_id?: string }; return payload.session_id ?? null; },
};
const removeDialect = registerDialect('permission-relaunch-test', 'permission-relaunch', dialect);
const removeProfile = registerProfile('permission-relaunch-test', {
  id: 'permission-relaunch', dialect: 'permission-relaunch', label: 'Relaunch', vendor: 'Test', custom: true,
  defaultModel: 'witness', models: [{ slug: 'witness', label: 'Witness' }],
});
const AGENT = 'permission-relaunch-temoin';
upsertAgent({
  name: AGENT,
  system_prompt: 'You are a witness.',
  config: { backend: 'permission-relaunch', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'default' },
});

const completed: string[] = [];
const onEvent = (ev: { kind: string; missionId?: string }): void => {
  if (ev.kind === 'mission_complete' && ev.missionId) completed.push(ev.missionId);
};
bus.on('event', onEvent);

const missions: string[] = [];
after(() => {
  bus.off('event', onEvent);
  for (const id of missions) killAgent(id, { source: 'test' });
  removeProfile();
  removeDialect();
});

const resultCount = (missionId: string) => dbApi.listEvents(missionId).filter((e) => e.type === 'result').length;

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a level changed between two turns relaunches the CLI on its session, once', async () => {
  const missionId = await spawnAgent(AGENT, 'hello');
  missions.push(missionId);
  await until(() => resultCount(missionId) === 1, 'the first result');
  await until(() => dbApi.getMission(missionId)?.session_id === 'relaunch-session', 'the session id');

  // Unchanged level: the message goes to the live process.
  assert.equal(await sendToAgent(missionId, 'same level'), 'delivered');
  await until(() => resultCount(missionId) === 2, 'the second result');
  assert.equal(launches.length, 1);

  dbApi.setMissionPermissionModeOverride(missionId, 'plan');
  assert.equal(await sendToAgent(missionId, 'now in plan'), 'delivered');
  await until(() => resultCount(missionId) === 3, 'the relaunched turn');
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[1], { mode: 'plan', resume: 'relaunch-session' });
  assert.ok(isRunning(missionId), 'the relaunched CLI owns the conversation');
  assert.equal(dbApi.getMission(missionId)?.status, 'running');
  assert.ok(!completed.includes(missionId), 'the relaunch is not the end of the mission');
  const users = dbApi.listEvents(missionId).filter((e) => e.type === 'user');
  assert.equal(users.length, 3, 'each message is logged once');

  // The new process already runs in `plan`: no second relaunch.
  assert.equal(await sendToAgent(missionId, 'still plan'), 'delivered');
  await until(() => resultCount(missionId) === 4, 'the fourth result');
  assert.equal(launches.length, 2);
});
