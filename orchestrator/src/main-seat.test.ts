/**
 * The main seat after a rebuilt database (TIM-0142): agent folders restored,
 * no `_main`, nothing recorded. The seat is filled when exactly one agent may
 * hold it, and announced once when it cannot be.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const { AGENTS_DIR, ROOKS_HOME } = await import('./paths.js');
await import('../tests/helpers/claude-provider.js');

const { dbApi } = await import('./db.js');
const { createEphemeralAgent, upsertAgent, patchAgentConfig } = await import('./agent.js');
const { MAIN_AGENT_KEY, mainAgentName, mainSeatState, renameAgentKeepingSeat } = await import('./main-agent.js');
const { TEAM_STATE_KEY, writeTeamState } = await import('./onboarding-team-state.js');
const { MAIN_SEAT_NOTICE_KEY, mainSeatNotice, reconcileMainSeat, seatMayHaveChanged, watchMainSeat } = await import('./main-seat.js');
const { busEventListenerCount } = await import('./bus.js');

type Notices = { raised: string[][]; resolved: number; raise(c: readonly string[]): boolean; resolve(): void };

function notices(): Notices {
  const n: Notices = {
    raised: [],
    resolved: 0,
    raise(candidates) { n.raised.push([...candidates]); return true; },
    resolve() { n.resolved++; },
  };
  return n;
}

/** A rebuilt database: no setting at all, no onboarding state, no agent folder. */
function rebuilt() {
  rmSync(AGENTS_DIR, { force: true, recursive: true });
  for (const key of [MAIN_AGENT_KEY, MAIN_SEAT_NOTICE_KEY, TEAM_STATE_KEY]) dbApi.deleteSetting(key);
  for (const w of dbApi.listWorkspaceRows()) dbApi.deleteWorkspace(w.slug, []);
}

function agent(name: string, extra: Record<string, unknown> = {}) {
  upsertAgent({ name, system_prompt: 'x', config: { role: 'orchestrator', cwd: ROOKS_HOME, ...extra } });
}

function recorded(): string | undefined {
  return dbApi.getAllSettings()[MAIN_AGENT_KEY];
}

test('no orchestrator at all: the seat stays empty and the card is raised once, not at every boot', () => {
  rebuilt();
  agent('worker', { role: 'code' });
  const n = notices();

  assert.deepEqual(reconcileMainSeat(n), { kind: 'empty', candidates: [], notified: true });
  assert.ok(dbApi.getAllSettings()[MAIN_SEAT_NOTICE_KEY], 'the empty spell is marked');
  assert.deepEqual(reconcileMainSeat(n), { kind: 'empty', candidates: [], notified: false }, 'a second boot says nothing more');
  assert.equal(n.raised.length, 1);
  assert.equal(recorded(), undefined);
  assert.deepEqual(mainSeatState(), { holder: null, empty: true, candidates: [] });
});

test('one eligible orchestrator found by role is recorded, so a second one created later does not empty the seat', () => {
  rebuilt();
  agent('Zeus');
  agent('acme.lead', { project: 'acme' });
  const n = notices();

  assert.deepEqual(reconcileMainSeat(n), { kind: 'held', name: 'Zeus' });
  assert.equal(recorded(), 'Zeus');
  assert.equal(n.raised.length, 0);

  agent('Atlas');
  assert.equal(mainAgentName(), 'Zeus', 'recorded: no longer a guess between two');
});

test('an empty seat with exactly one eligible orchestrator is given to it', () => {
  rebuilt();
  agent('Zeus');
  // The role lookup counts it and finds two; it may not hold the seat.
  createEphemeralAgent({ system_prompt: 'x', config: { role: 'orchestrator', cwd: ROOKS_HOME } });
  assert.equal(mainAgentName(), null);
  const n = notices();

  assert.deepEqual(reconcileMainSeat(n), { kind: 'elected', name: 'Zeus' });
  assert.equal(recorded(), 'Zeus');
  assert.equal(mainAgentName(), 'Zeus');
  assert.equal(n.raised.length, 0);
});

test('several eligible orchestrators: nobody is picked, the card names them, workspace hubs left out', () => {
  rebuilt();
  agent('Zeus');
  agent('Atlas');
  agent('_main.perso');
  const n = notices();

  const out = reconcileMainSeat(n);
  assert.equal(out.kind, 'empty');
  assert.deepEqual(out.kind === 'empty' ? [...out.candidates].sort() : null, ['Atlas', 'Zeus']);
  assert.equal(recorded(), undefined, 'choosing among several is the user\'s call');
  assert.deepEqual([...n.raised[0]!].sort(), ['Atlas', 'Zeus']);
  assert.match(mainSeatNotice(['Atlas', 'Zeus']).body, /Atlas, Zeus/);
  assert.match(mainSeatNotice([]).body, /Create one/);
});

test('the holder removed from disk: the only one left is recorded, else the card is raised', () => {
  rebuilt();
  agent('Zeus');
  agent('Atlas');
  agent('Hermes');
  dbApi.setSetting(MAIN_AGENT_KEY, 'Zeus');
  const n = notices();
  assert.deepEqual(reconcileMainSeat(n), { kind: 'held', name: 'Zeus' });

  rmSync(join(AGENTS_DIR, 'Zeus'), { force: true, recursive: true });
  assert.equal(reconcileMainSeat(n).kind, 'empty');
  assert.equal(n.raised.length, 1);

  rmSync(join(AGENTS_DIR, 'Hermes'), { force: true, recursive: true });
  assert.deepEqual(reconcileMainSeat(n), { kind: 'held', name: 'Atlas' });
  assert.equal(recorded(), 'Atlas');
  assert.equal(dbApi.getAllSettings()[MAIN_SEAT_NOTICE_KEY], undefined, 'the empty spell is over');
  assert.equal(n.resolved, 1, 'the card is taken back');

  // A later empty spell is announced again.
  rmSync(join(AGENTS_DIR, 'Atlas'), { force: true, recursive: true });
  assert.deepEqual(reconcileMainSeat(n), { kind: 'empty', candidates: [], notified: true });
  assert.equal(n.raised.length, 2);
});

test('the holder losing its role is re-evaluated like a removal', () => {
  rebuilt();
  agent('Zeus');
  agent('Atlas');
  dbApi.setSetting(MAIN_AGENT_KEY, 'Zeus');
  patchAgentConfig('Zeus', { role: 'code' });
  assert.deepEqual(reconcileMainSeat(notices()), { kind: 'held', name: 'Zeus' }, 'a recorded name is honoured as recorded');

  // Removing the record is what the rebuilt database did: Atlas is then alone.
  dbApi.deleteSetting(MAIN_AGENT_KEY);
  assert.deepEqual(reconcileMainSeat(notices()), { kind: 'held', name: 'Atlas' });
  assert.equal(recorded(), 'Atlas');
});

test('nothing is written while the first-run wizard is pending', () => {
  rebuilt();
  writeTeamState({ status: 'pending' });
  agent('Zeus');
  const n = notices();

  assert.deepEqual(reconcileMainSeat(n), { kind: 'deferred' });
  assert.equal(recorded(), undefined, 'the wizard would read the key as "name step answered"');
  assert.equal(n.raised.length, 0);
  dbApi.deleteSetting(TEAM_STATE_KEY);
});

test('the agent events that can change the seat, and only those', () => {
  assert.equal(seatMayHaveChanged({ kind: 'agent_created' }), true);
  assert.equal(seatMayHaveChanged({ kind: 'agent_deleted' }), true);
  assert.equal(seatMayHaveChanged({ kind: 'agent_updated', changed: ['name'], previousName: 'Zeus' }), true);
  assert.equal(seatMayHaveChanged({ kind: 'agent_updated', changed: ['role'], previousName: null }), true);
  assert.equal(seatMayHaveChanged({ kind: 'agent_updated', changed: ['model'], previousName: null }), false);
  assert.equal(seatMayHaveChanged({ kind: 'mission_complete' }), false);
});

test('the watcher seats a lone orchestrator once created, and a rename of the holder raises nothing', async () => {
  rebuilt();
  agent('worker', { role: 'code' });
  const n = notices();
  const before = busEventListenerCount();
  const stop = watchMainSeat(n);
  try {
    agent('Zeus');
    await Promise.resolve();
    assert.equal(recorded(), 'Zeus', 'the only candidate takes the seat');

    // A legacy holder, found by its literal and never recorded: the rename
    // event is published before the seat follows it, and read at once the
    // seat would look empty between two candidates.
    rebuilt();
    agent('ROOKS.main');
    agent('Atlas');
    await Promise.resolve();
    assert.equal(recorded(), undefined, 'a literal holder is not written down');
    assert.equal(renameAgentKeepingSeat('ROOKS.main', 'Rooks').ok, true);
    await Promise.resolve();
    assert.equal(recorded(), 'Rooks');
    assert.equal(n.raised.length, 0);
  } finally {
    stop();
  }
  assert.equal(busEventListenerCount(), before, 'no listener left behind');
});
