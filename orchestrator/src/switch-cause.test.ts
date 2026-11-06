/**
 * The cause of a switch is written into the persisted event ONLY when it is
 * a fallback: the chat renders a manual change and a quota fallback
 * differently, and the rows persisted before the field existed must keep
 * reading as manual changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-switch-cause-test-'));

const { dbApi } = await import('./db.js');
const { setMissionModel } = await import('./agent.js');

function lastSwitch(missionId: string): Record<string, unknown> {
  const rows = dbApi.listEvents(missionId).filter((e) => e.type === 'model_switch');
  assert.ok(rows.length > 0, 'a model_switch event is persisted');
  const raw = rows[rows.length - 1]!.payload;
  // Persisted as a JSON string: parse it the way a history replay would.
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
}

{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('a manual model change persists no cause, but names its backend', async () => {
  const id = randomUUID();
  dbApi.createMission(id, 'p.main', 'manual switch');
  dbApi.setMissionLlmOverrides(id, 'codex', 'gpt-5.5');
  const out = await setMissionModel(id, 'gpt-5.4');
  assert.equal(out?.status, 'next_turn');
  const p = lastSwitch(id);
  assert.equal(p.model, 'gpt-5.4');
  assert.equal(p.previous_model, 'gpt-5.5');
  assert.equal(p.backend, 'codex');
  assert.equal('cause' in p, false);
  assert.equal('cause_detail' in p, false);
});

test('a fallback model change carries its cause and trigger', async () => {
  const id = randomUUID();
  dbApi.createMission(id, 'p.main', 'fallback switch');
  dbApi.setMissionLlmOverrides(id, 'codex', 'gpt-5.5');
  await setMissionModel(id, 'gpt-5.4', { cause: 'fallback', causeDetail: 'codex out of quota' });
  const p = lastSwitch(id);
  assert.equal(p.cause, 'fallback');
  assert.equal(p.cause_detail, 'codex out of quota');
  assert.equal(p.backend, 'codex');
});

test('an explicit manual cause is not written either', async () => {
  const id = randomUUID();
  dbApi.createMission(id, 'p.main', 'explicit manual');
  dbApi.setMissionLlmOverrides(id, 'codex', 'gpt-5.5');
  await setMissionModel(id, 'gpt-5.4', { cause: 'manual', causeDetail: 'ignored' });
  const p = lastSwitch(id);
  assert.equal('cause' in p, false);
  assert.equal('cause_detail' in p, false);
});
