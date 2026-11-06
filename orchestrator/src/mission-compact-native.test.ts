/**
 * A native compaction through the real runner (`defaultCompactDeps`): the
 * command reaches a persistent CLI on stdin and a one-turn CLI as a launch
 * flagged `agentCommand`, the boundary the CLI prints concludes the
 * operation, the outcome lands in the thread, and the caller's message
 * follows in the same mission.
 */
import './test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { BuildSpawnOpts, Dialect, NormalizedEvent } from './backends/types.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { witnessCli } = await import('../tests/helpers/witness-cli.js');
const WITNESS_CLI = witnessCli(tmpdir());

const { spawnAgent, upsertAgent, killAgent } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { defaultCompactDeps, startCompaction, resetCompactOperations } = await import('./mission-compact.js');
type BusEvent = import('./bus.js').BusEvent;

// Persistent: one `result` per stdin line; `/compact` first prints a boundary.
const PERSISTENT = `
const out = (e) => console.log(JSON.stringify(e));
out({ type: 'system', payload: { subtype: 'init', session_id: 'compact-session' } });
out({ type: 'result', payload: { subtype: 'success', is_error: false, result: 'ok' } });
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) {
  const line = buf.slice(0, i); buf = buf.slice(i + 1);
  if (line === '/compact') out({ type: 'system', payload: { subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 10, post_tokens: 2 } } });
  out({ type: 'result', payload: { subtype: 'success', is_error: false, result: line === '/compact' ? '' : 'ok' } });
} });
`;

// One turn per process: the launch says whether the message is a command.
const ONE_TURN = `
const out = (e) => console.log(JSON.stringify(e));
const command = process.argv.includes('--command');
out({ type: 'system', payload: { subtype: 'init', session_id: 'turn-session' } });
if (command) out({ type: 'system', payload: { subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } } });
out({ type: 'result', payload: { subtype: 'success', is_error: false, result: command ? '' : 'ok' } });
`;

const launches: Array<{ dialect: string; message: string; agentCommand: boolean; resume: string | null }> = [];

function dialectOf(id: string, persistent: boolean): Dialect {
  return {
    defaultCmd: WITNESS_CLI, persistentProcess: persistent, finishMissionOnExit: false,
    sessionResumable: true, sessionStore: 'global', permissionModel: 'mcp-bridge', rateLimitReporting: 'none', hostedConnectors: false,
    nativeCompact: { command: '/compact' },
    async buildSpawn(opts: BuildSpawnOpts) {
      launches.push({ dialect: id, message: opts.message, agentCommand: opts.agentCommand === true, resume: opts.resumeSession });
      const args = ['-e', persistent ? PERSISTENT : ONE_TURN, ...(opts.agentCommand ? ['--', '--command'] : [])];
      return { cmd: WITNESS_CLI, args, cwd: opts.cfg.cwd, initialStdin: null };
    },
    writeUserInput(proc, text) { proc.stdin.write(`${text.replace(/\n/g, ' ')}\n`); },
    parseLine(line) { return [JSON.parse(line) as NormalizedEvent]; },
    extractSessionId(event) { const payload = event.payload as { session_id?: string }; return payload.session_id ?? null; },
  };
}

const cleanups: Array<() => void> = [];
for (const [id, persistent] of [['compact-live', true], ['compact-turn', false]] as const) {
  cleanups.push(registerDialect(`${id}-test`, id, dialectOf(id, persistent)));
  cleanups.push(registerProfile(`${id}-test`, {
    id, dialect: id, label: id, vendor: 'Test', custom: true,
    defaultModel: 'witness', models: [{ slug: 'witness', label: 'Witness' }],
  }));
  upsertAgent({
    name: `${id}-temoin`,
    system_prompt: 'You are a witness.',
    config: { backend: id, cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'default' },
  });
}

const missions: string[] = [];
after(() => {
  for (const id of missions) killAgent(id, { source: 'test' });
  for (const cleanup of cleanups.reverse()) cleanup();
  resetCompactOperations();
});

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function ended(missionId: string): Promise<Extract<BusEvent, { kind: 'compact_progress' }>> {
  return new Promise((resolve) => {
    const on = (ev: BusEvent): void => {
      if (ev.kind !== 'compact_progress' || (ev.phase !== 'done' && ev.phase !== 'error')) return;
      bus.off(`mission:${missionId}`, on);
      resolve(ev);
    };
    bus.on(`mission:${missionId}`, on);
  });
}

const results = (missionId: string) => dbApi.listEvents(missionId).filter((e) => e.type === 'result').length;
const compactRows = (missionId: string) => dbApi.listEvents(missionId)
  .filter((e) => e.type === 'compact')
  .map((e) => JSON.parse(e.payload) as Record<string, unknown>);

for (const backend of ['compact-live', 'compact-turn'] as const) {
  test(`${backend}: compacts in the same mission, records it, then delivers the message`, async () => {
    const missionId = await spawnAgent(`${backend}-temoin`, 'hello');
    missions.push(missionId);
    await until(() => results(missionId) === 1, 'the first result');
    await until(() => dbApi.getMission(missionId)?.session_id != null, 'the session id');
    // A one-turn process exits after its result: wait for it, as the chat would.
    if (backend === 'compact-turn') await new Promise((r) => setTimeout(r, 200));

    const done = ended(missionId);
    const out = startCompaction(missionId, { message: 'after' }, defaultCompactDeps());
    assert.equal(out.status, 202);
    assert.equal(out.body.operation?.mode, 'native');
    const last = await done;
    assert.equal(last.phase, 'done', String(last.error));
    assert.equal(last.targetMissionId, missionId);

    const rows = compactRows(missionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, 'done');
    assert.equal(rows[0]!.mode, 'native');
    const command = dbApi.listEvents(missionId)
      .map((e) => JSON.parse(e.payload) as { type?: string; message?: { content?: unknown }; origin?: { kind?: string } })
      .find((p) => p.type === 'user' && p.message?.content === '/compact');
    assert.equal(command?.origin?.kind, 'system', 'the command is logged as the daemon\'s, not the human\'s');

    await until(() => results(missionId) === 3, 'the follow-up message answered');
    const mine = launches.filter((l) => l.dialect === backend);
    if (backend === 'compact-turn') {
      assert.deepEqual(mine.map((l) => [l.message, l.agentCommand]), [['hello', false], ['/compact', true], ['after', false]]);
      assert.equal(mine[1]!.resume, 'turn-session');
    } else {
      // The live process took the command on stdin: no launch for it.
      assert.equal(mine.length, 1);
    }
  });
}
