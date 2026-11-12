/**
 * Coupe-circuit des échanges agent↔agent (incident testeur du 07/10/2026 :
 * deux agents se réveillaient l'un l'autre en boucle, malgré des "STOP"
 * écrits — toute réponse est elle-même un message qui réveille l'autre).
 *
 * Ce que ces tests protègent : une paire qui dépasse le plafond n'est plus
 * réveillée et ses messages sortent de `pending` ; une entrée humaine la
 * relance ; les retours de tasks Kanban ne comptent jamais.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { randomUUID } from 'node:crypto';

process.env.ROOKS_WAKE_PAIR_MAX_MESSAGES = '3';
process.env.ROOKS_WAKE_PAIR_WINDOW_MS = '600000';
const { dbApi } = await import('./db.js');
const { handleAgentMessage, handleUserInput } = await import('./wake.js');
const { admitAgentMessage, clearAgentPairs, isHumanInput } = await import('./agent-pair-breaker.js');

const missions = new Map<string, string>();
function missionOf(agent: string): string {
  let id = missions.get(agent);
  if (!id) {
    id = randomUUID();
    dbApi.createMission(id, agent, 'test', { channel: 'agent' });
    missions.set(agent, id);
  }
  return id;
}

/** Enqueue a message and run the wake-loop handler on it. True if woken.
 *  `request` by default: a free `msg` wakes nobody, so it never reaches the breaker. */
function send(
  from: string, to: string, payload = 'ping', id = randomUUID(), kind: 'msg' | 'request' = 'request',
): { id: string; woken: boolean } {
  const row = dbApi.enqueueMessage({ id, fromMission: missionOf(from), fromAgent: from, toAgent: to, kind, payload });
  let woken = false;
  handleAgentMessage(
    { kind: 'agent_message', missionId: row.from_mission, messageId: row.id, toAgent: to, fromAgent: from, fromMission: row.from_mission },
    () => { woken = true; },
  );
  return { id: row.id, woken };
}

function alertsAbout(a: string, b: string): number {
  return dbApi.listAllInbox({ limit: 500 })
    .filter((m) => m.from_agent === 'orchestrator' && m.payload.includes(`${a} ↔ ${b}`)).length;
}

beforeEach(() => clearAgentPairs());

test('une paire qui dépasse le plafond n\'est plus réveillée, dans les deux sens', () => {
  assert.equal(send('jeff', 'nexus').woken, true);
  assert.equal(send('nexus', 'jeff').woken, true);
  assert.equal(send('jeff', 'nexus').woken, true);
  const over = send('nexus', 'jeff', 'STOP');
  assert.equal(over.woken, false);
  assert.equal(dbApi.getMessage(over.id)?.status, 'held');
  // Retenu = hors de `pending` : ni le sweep, ni un réveil d'une autre cause,
  // ni un agent qui relève sa boîte ne le verront.
  assert.ok(!dbApi.listInbox('jeff', { status: 'pending' }).some((m) => m.id === over.id));

  // Verrouillée : la suite reste retenue, sans seconde alerte.
  const next = send('jeff', 'nexus', 'STOP STOP');
  assert.equal(next.woken, false);
  assert.equal(dbApi.getMessage(next.id)?.status, 'held');
  assert.equal(alertsAbout('jeff', 'nexus'), 1);
});

test('la casse du nom ne crée pas une seconde paire', () => {
  send('Ana', 'bob');
  send('bob', 'ana');
  send('ANA', 'Bob');
  assert.equal(send('bob', 'Ana').woken, false);
});

test('une entrée humaine relance la paire', () => {
  for (let i = 0; i < 3; i++) send('alpha', 'beta');
  assert.equal(send('beta', 'alpha').woken, false);

  // Un tool_result et un message injecté par le démon ne sont pas un humain.
  handleUserInput(missionOf('beta'), {
    type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  });
  handleUserInput(missionOf('beta'), {
    type: 'user', message: { role: 'user', content: 'digest' }, origin: { kind: 'wake', from: 'orchestrator-wake' },
  });
  assert.equal(send('alpha', 'beta').woken, false);

  handleUserInput(missionOf('beta'), { type: 'user', message: { role: 'user', content: 'reprenez' } });
  assert.equal(send('alpha', 'beta').woken, true);
  assert.equal(send('beta', 'alpha').woken, true);
});

test('une idée poussée depuis la TO DO relance aussi la paire', () => {
  for (let i = 0; i < 4; i++) send('gamma', 'delta');
  assert.equal(send('gamma', 'delta').woken, false);
  assert.equal(send('cockpit', 'delta', 'Idée remontée').woken, true);
  assert.equal(send('gamma', 'delta').woken, true);
});

test('les retours de tasks Kanban et de missions ne sont jamais retenus', () => {
  for (let i = 0; i < 10; i++) {
    const task = send('p.coder', 'p.main', JSON.stringify({ kind: 'task_closed', task_id: randomUUID(), task_status: 'DONE' }));
    assert.equal(task.woken, true);
    assert.equal(dbApi.getMessage(task.id)?.status, 'pending');
    const mission = send('p.coder', 'p.main', JSON.stringify({ kind: 'mission_complete', status: 'completed' }));
    assert.equal(mission.woken, true);
  }
  // Et ils n'entament pas le crédit de la paire.
  for (let i = 0; i < 3; i++) assert.equal(send('p.coder', 'p.main').woken, true);
});

test('un msg libre ne réveille pas et ne compte pas contre la paire', () => {
  for (let i = 0; i < 10; i++) {
    const free = send('theta', 'iota', 'ping', randomUUID(), 'msg');
    assert.equal(free.woken, false);
    assert.equal(dbApi.getMessage(free.id)?.status, 'pending');
  }
  for (let i = 0; i < 3; i++) assert.equal(send('theta', 'iota').woken, true);
});

test('la fenêtre glisse : les messages anciens ne comptent plus', () => {
  const t0 = 1_000_000;
  const msg = (n: number) => ({ id: `w-${n}`, from_agent: 'eps', to_agent: 'zeta', payload: 'x' });
  assert.equal(admitAgentMessage(msg(1), t0), 'wake');
  assert.equal(admitAgentMessage(msg(2), t0 + 1), 'wake');
  assert.equal(admitAgentMessage(msg(3), t0 + 2), 'wake');
  assert.equal(admitAgentMessage(msg(4), t0 + 600_001), 'wake');
});

test('isHumanInput : seul le texte tapé par un humain compte', () => {
  assert.equal(isHumanInput({ type: 'user', message: { role: 'user', content: 'go' } }), true);
  assert.equal(isHumanInput({
    type: 'user', message: { role: 'user', content: '/plan x' }, origin: { presentation: { parts: [] } },
  }), true);
  // Événement brut d'un CLI (prompt de sous-agent) : clés en plus.
  assert.equal(isHumanInput({
    type: 'user', message: { role: 'user', content: 'sub' }, session_id: 's', parent_tool_use_id: 't',
  }), false);
  assert.equal(isHumanInput({ type: 'user', message: { role: 'user', content: 'r' }, origin: { kind: 'task_return', from: 'p.coder' } }), false);
  assert.equal(isHumanInput(null), false);
});
