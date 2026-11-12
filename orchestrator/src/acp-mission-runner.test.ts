/**
 * The runner on a session-driven backend, end to end: `spawnAgent` →
 * `Backend.openSession` → driver, with the scripted fake ACP agent
 * (`backends/acp/__fixtures__/fake-acp-agent.mjs`) behind `host.spawn`. Never a
 * real opencode or Hermes, and the profile lives here, not in a provider plugin.
 *
 * What is protected: the driver's events land in the same persisted stream as
 * every other dialect's, follow-up turns and permissions go through the session,
 * the mission's token reaches the MCP servers through the protocol only, and a
 * chat STOP cancels the turn without killing the conversation.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
process.env.ROOKS_PERMISSION_AUTONOMOUS_TIMEOUT_MS = '400';

const { getHost } = await import('./host/index.js');
const {
  spawnAgent, upsertAgent, sendToAgent, killAgent, interruptAgent, respawnWithResume, isRunning, getTurnState, steerMission,
} = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
type BusEvent = import('./bus.js').BusEvent;
const { registerProfile } = await import('./backends/registry.js');
const { listPending, resolvePermission } = await import('./permissions.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { backendNames } = await import('./backends/index.js');
const { mountOfficialProviders, stubCliBinaries } = await import('../tests/helpers/official-providers.js');
type EventRow = ReturnType<typeof dbApi.listEvents>[number];

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'backends', 'acp', '__fixtures__', 'fake-acp-agent.mjs');
const PROFILE = 'acp-runner-probe';
const AGENT = 'acp-runner-temoin';

invalidateSettingsCache();
// The ACP agents are the release's own plugin: mounted the way the daemon loads it. The probe profile rides on
// Hermes' provider (an agent that asks, so every permission goes through the card).
await mountOfficialProviders();
const removeProfile = registerProfile('acp-runner-test', {
  id: PROFILE, dialect: 'hermes', label: 'ACP runner probe', defaultModel: null, models: [],
});
upsertAgent({
  name: AGENT,
  system_prompt: 'You are a witness.',
  config: { backend: PROFILE, cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
});

type Launch = { child: ChildProcessWithoutNullStreams; cmd: string; args: string[]; env: NodeJS.ProcessEnv };
const launches: Launch[] = [];
let agentEnv: Record<string, string> = {};

const host = getHost();
const originalSpawn = host.spawn;
host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
  const child = nodeSpawn(process.execPath, [FAKE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...agentEnv },
  }) as ChildProcessWithoutNullStreams;
  child.stderr.resume();
  launches.push({ child, cmd, args, env: (opts?.env ?? {}) as NodeJS.ProcessEnv });
  return child;
}) as typeof host.spawn;

// The agent that decides its own tool uses is known by its profile id: the
// product's own `opencode` profile, which exists only when the CLI is on the
// PATH. The probe profile is a third party's on Hermes' dialect, so its launch
// is authorized against the file `hermes-acp` resolves to: it needs one too.
// Stand-in files are enough — `host.spawn` above never runs them.
await stubCliBinaries('opencode', 'hermes-acp');
assert.ok(backendNames().includes('opencode'), 'the opencode profile is active with its CLI on the PATH');
upsertAgent({
  name: `${AGENT}-own-guard`,
  system_prompt: 'You are a witness.',
  config: { backend: 'opencode', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
});

after(() => {
  host.spawn = originalSpawn;
  removeProfile();
  for (const l of launches) l.child.kill('SIGKILL');
});

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for: ${what}`);
    await tick(10);
  }
}

/** A persisted event, its payload parsed. */
type Persisted = { type: string; payload: Record<string, unknown> };

const events = (missionId: string): Persisted[] => dbApi.listEvents(missionId)
  .map((e: EventRow) => ({ type: e.type, payload: JSON.parse(e.payload) as Record<string, unknown> }));
const results = (missionId: string): Persisted[] => events(missionId).filter((e) => e.type === 'result');

function assistantText(missionId: string): string {
  return events(missionId)
    .filter((e) => e.type === 'assistant')
    .map((e) => JSON.stringify(e.payload))
    .join('\n');
}

/** The `turn_complete` outcomes the bus publishes for a mission, from now on:
 *  what the pilot's return, the request replies and the closure question read. */
function turnEnds(missionId: () => string | undefined): { outcomes: () => (string | undefined)[]; stop: () => void } {
  const seen: { id: string; outcome: string | undefined }[] = [];
  const on = (ev: BusEvent): void => {
    if (ev.kind === 'turn_complete') seen.push({ id: ev.missionId, outcome: ev.outcome });
  };
  bus.on('event', on);
  return {
    outcomes: () => seen.filter((e) => e.id === missionId()).map((e) => e.outcome),
    stop: () => { bus.off('event', on); },
  };
}

async function spawnChat(message: string, env: Record<string, string> = {}, resume?: string | null): Promise<string> {
  agentEnv = env;
  return spawnAgent(AGENT, message, undefined, { explicitResume: resume ?? null });
}

test('a first turn runs through the driver: init, reply, result and usage join the persisted stream', async () => {
  const before = launches.length;
  let id: string | undefined;
  const ends = turnEnds(() => id);
  const missionId = await spawnChat('hello');
  id = missionId;
  assert.equal(launches.length, before + 1);
  await until(() => results(missionId).length === 1, 'the first result');
  await until(() => ends.outcomes().length === 1, 'the end of the turn');
  ends.stop();
  assert.deepEqual(ends.outcomes(), [undefined], 'an ordinary turn ends once, as a plain turn');

  const types = events(missionId).map((e) => e.type);
  assert.ok(types.includes('user'), 'the user turn is logged by the runner');
  const init = events(missionId).find((e) => e.type === 'system');
  assert.equal(init!.payload.subtype, 'init');
  assert.equal(init!.payload.backend, PROFILE);
  assert.match(assistantText(missionId), /Hello/);
  // extractSessionId ran on the init event.
  assert.equal(dbApi.getMission(missionId)!.session_id, 'sess-1');
  // The turn ended: the strip stops saying "thinking", the mission stays running.
  assert.equal(getTurnState(missionId)!.turnActive, false);
  assert.equal(dbApi.getMission(missionId)!.status, 'running');
  assert.ok(isRunning(missionId));

  // No line parser reads the pipe: an event is persisted once, not twice.
  assert.equal(events(missionId).filter((e) => e.type === 'system').length, 1);
  killAgent(missionId, { source: 'test' });
});

test('the system prompt is carried by the session and never by argv', async () => {
  const missionId = await spawnChat('echo');
  await until(() => results(missionId).length === 1, 'the echo result');
  // First turn of a new session: the system prompt block, then the message.
  assert.match(assistantText(missionId), /<rooks_instructions>[\s\S]*You are a witness\.[\s\S]*echo/);
  const launch = launches[launches.length - 1]!;
  assert.ok(!launch.args.some((a) => a.includes('You are a witness.') || a.includes('echo')));
  killAgent(missionId, { source: 'test' });
});

test('a steer on a session without one of its own cancels the turn and prompts the instruction next, same process', async () => {
  const missionId = await spawnChat('slow');
  const ends = turnEnds(() => missionId);
  await until(() => events(missionId).some((e) => e.type === 'system'), 'the session opens');
  await tick(150);
  const child = launches[launches.length - 1]!.child;
  const launchCount = launches.length;
  // The instant a wait must not stop on (TODO #662): the stopped turn's result is
  // persisted, the agent is idle, the instruction is not logged yet.
  let window: { ended: boolean; active: boolean | undefined } | null = null;
  const inWindow = (ev: BusEvent): void => {
    if (ev.kind === 'turn_complete' && ev.missionId === missionId && ev.outcome === 'cancelled') {
      window = { ended: dbApi.missionTurnEnded(missionId), active: getTurnState(missionId)?.turnActive };
    }
  };
  bus.on('event', inWindow);
  assert.deepEqual(await steerMission(missionId, 'hello'), { outcome: 'steered', method: 'restart' });
  await until(() => results(missionId).length === 2, 'the cancelled turn, then the steered one');
  await until(() => ends.outcomes().length === 2, 'the end of both turns');
  ends.stop();
  bus.off('event', inWindow);
  assert.deepEqual(window, { ended: false, active: false });
  assert.equal(dbApi.missionTurnEnded(missionId), true, 'the steered turn ends it');
  // The stopped turn is not an answer: only the steered one ends as a plain
  // turn, the one the pilot's return goes with (TODO #568).
  assert.deepEqual(ends.outcomes(), ['cancelled', undefined]);

  assert.equal((results(missionId)[0]!.payload as { subtype?: string }).subtype, 'cancelled');
  assert.equal(launches.length, launchCount, 'no respawn');
  assert.equal(child.exitCode, null, 'process kept');
  // In the thread, the instruction comes after the end of the turn it stopped.
  const order = events(missionId).map((e) => e.type);
  const firstResult = order.indexOf('result');
  const steered = order.lastIndexOf('user');
  assert.ok(order.includes('turn_interrupted'));
  assert.ok(steered > firstResult, `the instruction follows the cancelled result (${order.join(',')})`);
  killAgent(missionId, { source: 'test' });
});

test('follow-up turns go through driver.prompt on the same process, in order', async () => {
  const missionId = await spawnChat('hello');
  await until(() => results(missionId).length === 1, 'the first result');
  const launchCount = launches.length;

  assert.equal(await sendToAgent(missionId, 'echo'), 'delivered');
  // Sent while the previous turn still runs: it waits, it is not dropped.
  assert.equal(await sendToAgent(missionId, 'hello'), 'delivered');
  await until(() => results(missionId).length === 3, 'the two follow-up results');

  assert.equal(launches.length, launchCount, 'no respawn');
  // Typed turns, not the tool results the agent's own calls produce.
  const typed = events(missionId).filter((e) => e.type === 'user'
    && typeof (e.payload.message as { content: unknown }).content === 'string');
  assert.equal(typed.length, 3);
  // The second turn does not repeat the system prompt.
  const echoed = events(missionId)
    .filter((e) => e.type === 'assistant')
    .map((e) => JSON.stringify(e.payload))
    .find((p) => p.includes('echo') && !p.includes('Hello'));
  assert.ok(echoed && !echoed.includes('rooks_instructions'));
  killAgent(missionId, { source: 'test' });
});

test('the mission token reaches the MCP servers through the session request only — on the release\'s own opencode', async () => {
  // The product's profile: official by registration, so the process gets its own token (not a reference),
  // and the servers the session declares carry that same value, swapped by the daemon on the pipe.
  agentEnv = {};
  const missionId = await spawnAgent(`${AGENT}-own-guard`, 'mcp');
  await until(() => results(missionId).length === 1, 'the mcp result');
  const launch = launches[launches.length - 1]!;
  const token = launch.env.ROOKS_API_TOKEN;
  assert.ok(token && !token.startsWith('rooks-seal-'), 'the mission has a token of its own, not a reference');

  const text = events(missionId)
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => (e.payload as { message: { content: Array<{ text?: string }> } }).message.content)
    .map((b) => b.text ?? '')
    .join('');
  const servers = JSON.parse(text.slice(text.indexOf('['))) as Array<{ name: string; env: Array<{ name: string; value: string }> }>;
  for (const name of ['rooks', 'rooks_ask']) {
    const server = servers.find((s) => s.name === name)!;
    assert.equal(server.env.find((e) => e.name === 'ROOKS_API_TOKEN')?.value, token, `${name} carries the token`);
  }
  assert.ok(!launch.args.some((a) => a.includes(token)), 'never in argv');
  assert.equal(JSON.stringify(servers).includes('rooks-seal-'), false, 'no reference reached the agent');
  killAgent(missionId, { source: 'test' });
});

test('a permission request becomes an Allow/Deny card, answered to the agent', async () => {
  const missionId = await spawnChat('perm');
  await until(() => listPending(missionId).length === 1, 'the permission card');
  const card = listPending(missionId)[0]!;
  // The agent's own label for the call: what the person reads on the card.
  assert.equal(card.tool_name, 'write /etc/passwd');
  assert.equal(card.tool_use_id, 't2');
  assert.deepEqual(card.input, { path: '/etc/passwd' });
  // The card is persisted for a reload mid-prompt, like the mcp-bridge's.
  assert.ok(events(missionId).some((e) => e.type === 'permission_request'));

  assert.ok(resolvePermission(card.id, { behavior: 'allow' }, 'user'));
  await until(() => results(missionId).length === 1, 'the result after the answer');
  assert.match(assistantText(missionId), /selected:allow/);
  killAgent(missionId, { source: 'test' });

  const denied = await spawnChat('perm');
  await until(() => listPending(denied).length === 1, 'the second card');
  assert.ok(resolvePermission(listPending(denied)[0]!.id, { behavior: 'deny', message: 'no' }, 'user'));
  await until(() => results(denied).length === 1, 'the result after the refusal');
  assert.match(assistantText(denied), /selected:deny/);
  killAgent(denied, { source: 'test' });
});

/** A mission owned by a verified developer account, whose licence is the internal plan. */
async function withDeveloperOwner(run: (ownerUserId: string) => Promise<void>): Promise<void> {
  const { licenseState, setLicenseState } = await import('./license/runtime.js');
  const original = licenseState();
  setLicenseState({
    ...original, status: 'valid', reason: null, planId: 'internal', modules: '*', plugins: '*', users: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const owner = dbApi.getUserByEmail('dev@example.test')
    ?? createTestAccount(dbApi, { email: 'dev@example.test', name: 'Dev', passwordHash: 'x', isSuperadmin: true });
  try { await run(owner.id); } finally { setLicenseState(original); }
}

test('a developer-owned chat is allowed without a card, traced like the HTTP route does', async () => {
  await withDeveloperOwner(async (ownerUserId) => {
    agentEnv = {};
    const missionId = await spawnAgent(AGENT, 'perm', undefined, { explicitResume: null, ownerUserId });
    await until(() => results(missionId).length === 1, 'the result without any card');
    assert.match(assistantText(missionId), /selected:allow/);
    assert.equal(listPending(missionId).length, 0);
    const traced = events(missionId).filter((e) => e.type === 'permission_dev_allowed');
    assert.equal(traced.length, 1);
    assert.equal((traced[0]!.payload as { auth_kind?: string }).auth_kind, 'session');
    killAgent(missionId, { source: 'test' });
  });
});

test('a form card is never auto-allowed for a developer, as on POST /api/permissions/request', async () => {
  await withDeveloperOwner(async (ownerUserId) => {
    agentEnv = {};
    const missionId = await spawnAgent(AGENT, 'permform', undefined, { explicitResume: null, ownerUserId });
    await until(() => results(missionId).length === 1, 'the result after the form is refused');
    // The empty form is malformed: it goes through the card pipeline (and is
    // refused there), not through the developer shortcut.
    assert.equal(events(missionId).filter((e) => e.type === 'permission_dev_allowed').length, 0);
    assert.doesNotMatch(assistantText(missionId), /selected:allow/);
    killAgent(missionId, { source: 'test' });
  });
});

test('on an autonomous mission with nobody to answer, the card expires into a denial', async () => {
  agentEnv = {};
  const missionId = await spawnAgent(AGENT, 'perm', { channel: 'dispatcher' }, { explicitResume: null });
  await until(() => listPending(missionId).length === 1, 'the permission card');
  await until(() => results(missionId).length === 1, 'the result after the delay', 8000);
  assert.match(assistantText(missionId), /selected:deny/);
  assert.equal(listPending(missionId).length, 0);
  assert.ok(events(missionId).some((e) => e.type === 'permission_expired'));
  killAgent(missionId, { source: 'test' });
});

test('STOP on a chat cancels the turn and keeps the process and the conversation', async () => {
  const missionId = await spawnChat('slow');
  const ends = turnEnds(() => missionId);
  await until(() => events(missionId).some((e) => e.type === 'system'), 'the session opens');
  await tick(150);
  const child = launches[launches.length - 1]!.child;
  const out = interruptAgent(missionId);
  assert.equal(out.status, 'interrupted');
  assert.equal(out.turnActive, true);
  await until(() => results(missionId).length === 1, 'the cancelled result');

  const result = results(missionId)[0]!.payload as { subtype?: string; stop_reason?: string };
  assert.equal(result.subtype, 'cancelled');
  assert.equal(child.exitCode, null, 'process kept');
  assert.equal(child.signalCode, null);
  assert.ok(isRunning(missionId));
  assert.ok(events(missionId).some((e) => e.type === 'turn_interrupted'));
  // A STOP has no next turn to carry the answer: its end is a plain one, the
  // pilot learns the turn is over (unlike a steer's, TODO #568).
  await until(() => ends.outcomes().length === 1, 'the end of the stopped turn');
  assert.deepEqual(ends.outcomes(), [undefined]);
  ends.stop();

  // The next message goes to the same session.
  const launchCount = launches.length;
  assert.equal(await sendToAgent(missionId, 'hello'), 'delivered');
  await until(() => results(missionId).length === 2, 'the turn after the cancel');
  assert.equal(launches.length, launchCount);
  killAgent(missionId, { source: 'test' });
});

test('STOP on a task mission keeps the kill: its `interrupted` death is what blocks the task', async () => {
  agentEnv = {};
  const taskId = `task-${Math.random().toString(36).slice(2, 10)}`;
  dbApi.createTask(taskId, 'acp task', AGENT, { type: 'code' });
  const missionId = await spawnAgent(AGENT, 'hello', { channel: 'dispatcher', meta: { task_id: taskId } }, { explicitResume: null });
  dbApi.assignTaskMission(taskId, missionId);
  await until(() => results(missionId).length >= 1, 'the first turn');
  await sendToAgent(missionId, 'slow');
  await until(() => getTurnState(missionId)?.turnActive === true, 'a turn is active');
  const child = launches[launches.length - 1]!.child;
  interruptAgent(missionId);
  await until(() => child.exitCode !== null || child.signalCode !== null, 'the process is gone');
  await until(() => dbApi.getMission(missionId)!.status !== 'running', 'the mission is finalised');
  assert.equal(dbApi.getMission(missionId)!.status, 'terminated');
});

test('kill lets go of the session: the process ends and the mission is finalised', async () => {
  const missionId = await spawnChat('hello');
  await until(() => results(missionId).length === 1, 'the first result');
  const child = launches[launches.length - 1]!.child;
  assert.equal(killAgent(missionId, { source: 'test' }), 'killed');
  await until(() => child.exitCode !== null || child.signalCode !== null, 'the process is gone');
  await until(() => dbApi.getMission(missionId)!.status !== 'running', 'the mission is finalised');
  assert.equal(isRunning(missionId), false);
  // A gesture of ours, not a crash and not a natural end.
  assert.equal(dbApi.getMission(missionId)!.status, 'terminated');
});

test('a dead process is resumed by session id: the agent reopens the stored session', async () => {
  const missionId = await spawnChat('hello', { FAKE_ACP_RESUME: '1' });
  await until(() => results(missionId).length === 1, 'the first result');
  const first = launches[launches.length - 1]!.child;
  assert.equal(dbApi.getMission(missionId)!.session_id, 'sess-1');
  killAgent(missionId, { source: 'test' });
  await until(() => first.exitCode !== null || first.signalCode !== null, 'the process is gone');
  await until(() => !isRunning(missionId), 'the runner forgot it');

  const launchCount = launches.length;
  assert.equal(await respawnWithResume(missionId, 'echo'), true);
  assert.equal(launches.length, launchCount + 1, 'a new process');
  await until(() => results(missionId).length === 2, 'the turn after the resume');
  // Reopened, not replayed into the thread: the history the agent streams while
  // reopening is not a reply, and the session keeps its id.
  assert.equal(dbApi.getMission(missionId)!.session_id, 'sess-1');
  const text = assistantText(missionId);
  assert.ok(!text.includes('replayed'));
  // The system prompt is not sent again to a session that already has it.
  assert.equal((text.match(/rooks_instructions/g) ?? []).length, 0);
  killAgent(missionId, { source: 'test' });
});

test('a handshake the agent refuses ends the mission with a message the user can read', async () => {
  const missionId = await spawnChat('hello', { FAKE_ACP_AUTH: '1' });
  await until(() => dbApi.getMission(missionId)!.status !== 'running', 'the mission fails');
  assert.equal(dbApi.getMission(missionId)!.status, 'failed');
  const result = results(missionId)[0]!.payload as { is_error?: boolean; error?: string };
  assert.equal(result.is_error, true);
  assert.match(result.error ?? '', /sign in/);
  assert.equal(isRunning(missionId), false);
});

test('the process dying under a turn surfaces as a failed mission, not a hang', async () => {
  const missionId = await spawnChat('die');
  await until(() => dbApi.getMission(missionId)!.status !== 'running', 'the mission fails');
  assert.equal(dbApi.getMission(missionId)!.status, 'failed');
  assert.equal(isRunning(missionId), false);
});

test('a chat whose session fails ends `failed` (decided: `bounced` is set for chats too, status unchanged)', async () => {
  // `finalizeBouncedTask` keeps its own `bounced` for tasks; `onFailed` marks a
  // chat the same way so that the SIGTERM it sends is never read as a clean
  // exit. The user reads the error in the thread and decides what comes next.
  const missionId = await spawnChat('hello', { FAKE_ACP_AUTH: '1' });
  await until(() => dbApi.getMission(missionId)!.status !== 'running', 'the mission fails');
  assert.equal(dbApi.getTaskByMission(missionId), undefined, 'a chat, not a task');
  const mission = dbApi.getMission(missionId)!;
  assert.equal(mission.status, 'failed');
  assert.equal(mission.interrupted_reason, 'crash');
});

test('an agent that guards itself announces it: permissions_by_agent reaches the persisted init', async () => {
  agentEnv = {};
  const missionId = await spawnAgent(`${AGENT}-own-guard`, 'hello', undefined, { explicitResume: null });
  await until(() => results(missionId).length === 1, 'the first result');
  const init = events(missionId).find((e) => e.type === 'system')!;
  assert.equal(init.payload.permissions_by_agent, true);
  assert.equal(init.payload.backend, 'opencode');
  killAgent(missionId, { source: 'test' });
});
