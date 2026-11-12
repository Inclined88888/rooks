/**
 * A skill invoked in a follow-up turn on a one-shot backend (codex, grok…) keeps
 * its display sections: the persisted `user` event carries the presentation, so
 * the chat folds the procedure instead of pasting hundreds of lines in the bubble.
 * The text sent to the agent is the same either way.
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
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { composePrompt } = await import('./prompt-presentation.js');

const sent: string[] = [];
const dialect: Dialect = {
  defaultCmd: WITNESS_CLI, persistentProcess: false, finishMissionOnExit: false,
  sessionResumable: true, sessionStore: 'global', permissionModel: 'none', rateLimitReporting: 'none', hostedConnectors: false,
  async buildSpawn(opts) {
    sent.push(opts.message);
    const output = [
      { type: 'system', payload: { subtype: 'init', session_id: 'one-shot-presentation' } },
      { type: 'result', payload: { subtype: 'success', is_error: false, result: 'done' } },
    ];
    return {
      cmd: WITNESS_CLI,
      args: ['-e', `setTimeout(() => { for (const event of ${JSON.stringify(output)}) console.log(JSON.stringify(event)); }, 30);`],
      cwd: opts.cfg.cwd, initialStdin: null,
    };
  },
  writeUserInput() {},
  parseLine(line) { return [JSON.parse(line) as NormalizedEvent]; },
  extractSessionId(event) { const payload = event.payload as { session_id?: string }; return payload.session_id ?? null; },
};
const removeDialect = registerDialect('one-shot-presentation-test', 'one-shot-presentation', dialect);
const removeProfile = registerProfile('one-shot-presentation-test', {
  id: 'one-shot-presentation', dialect: 'one-shot-presentation', label: 'One shot', vendor: 'Test', custom: true,
  defaultModel: 'witness', models: [{ slug: 'witness', label: 'Witness' }],
});
const AGENT = 'one-shot-presentation-temoin';
upsertAgent({
  name: AGENT,
  system_prompt: 'You are a witness.',
  config: { backend: 'one-shot-presentation', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
});

const missions: string[] = [];
after(() => {
  for (const id of missions) killAgent(id, { source: 'test' });
  removeProfile();
  removeDialect();
});

const userEvents = (missionId: string) => dbApi.listEvents(missionId)
  .filter((e) => e.type === 'user')
  .map((e) => JSON.parse(e.payload) as { message: { content: string }; origin?: { presentation?: unknown } });
const resultCount = (missionId: string) => dbApi.listEvents(missionId).filter((e) => e.type === 'result').length;

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a skill sent between two one-shot turns is persisted with its presentation', async () => {
  const missionId = await spawnAgent(AGENT, 'hello');
  missions.push(missionId);
  await until(() => resultCount(missionId) === 1, 'the first result');
  // The `result` line comes before the process exits; until the exit handler
  // drops it from the registry, a second send is refused as `turn_in_flight`.
  await until(() => !isRunning(missionId), 'the first process to leave');

  const turn = composePrompt([
    { kind: 'instruction', label: 'skillInvoked', labelVars: { id: 'geo' }, text: '[Skill] <skill id="geo">\nstep 1\n</skill>\n\n---\n\n' },
    { kind: 'text', text: 'Ma demande : audit' },
  ]);
  assert.equal(await sendToAgent(missionId, turn.text, undefined, null, turn.presentation), 'delivered');
  await until(() => resultCount(missionId) === 2, 'the second result');

  const second = userEvents(missionId)[1]!;
  assert.equal(second.message.content, turn.text, 'what the agent receives is untouched');
  assert.deepEqual(second.origin?.presentation, turn.presentation);
  assert.equal(sent[sent.length - 1], turn.text);
});

test('a digest delivered with its segments keeps them in the stored user event', async () => {
  const digest = composePrompt([
    { kind: 'instruction', text: 'Mission return — preamble\n\n' },
    { kind: 'instruction', label: 'taskDone', text: '── Message 1 (from `p.coder`) — [code] DONE: volet ──\n', segment: 0 },
    { kind: 'text', text: 'Closing comment:\nfait', segment: 0 },
  ], [{ from: 'p.coder', at: 1_000, mission_id: null, card: { task_id: 't1', title: 'volet', type: 'code', status: 'DONE' } }]);
  const origin = { kind: 'task_return' as const, from: 'p.coder', presentation: digest.presentation };
  const missionId = await spawnAgent(AGENT, digest.text, undefined, { origin });
  missions.push(missionId);
  await until(() => resultCount(missionId) === 1, 'the digest turn');

  const stored = userEvents(missionId)[0]!;
  assert.equal(stored.message.content, digest.text);
  assert.deepEqual(stored.origin?.presentation, digest.presentation);
});
