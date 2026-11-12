/**
 * SUG-0014: on an autonomous mission a form expired on the 5-minute delay of an
 * Allow / Deny card, while the user was still reading it. A form (`ask_user`)
 * now waits on its own, longer delay; tool cards keep theirs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-form-timeout-test-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { requestPermission, listPending, resolvePermission, cardTimeoutMs } = await import('./permissions.js');
const { resolve: resolveSetting, setSetting, invalidateSettingsCache } = await import('./settings.js');
const { dbApi } = await import('./db.js');

const MIN = 60_000;
const plan = { form: { kind: 'series_plan', chantier: 'Nightly chantier', volets: [{ title: 'Front' }] } };

/** Opens a card, reads what it armed, then answers it so no timer outlives the test. */
function openCard(missionId: string, toolName: string, input: unknown) {
  const tool_use_id = `tu-${missionId}-${toolName}`;
  const pending = requestPermission({ mission_id: missionId, agent: 'acme.ops', tool_name: toolName, input, tool_use_id });
  const card = listPending(missionId).find((p) => p.tool_use_id === tool_use_id);
  assert.ok(card, `no card for ${toolName}`);
  const event = dbApi.listEvents(missionId).filter((e) => e.type === 'permission_request').at(-1)!;
  const payload = JSON.parse(event.payload) as { expires_at?: number };
  resolvePermission(card.id, { behavior: 'deny', message: 'test over' });
  return { card, payload, pending };
}

test('the form delay resolves from its default, then the database, then the env', () => {
  assert.equal(resolveSetting('ROOKS_PERMISSION_FORM_TIMEOUT_MS')?.value, 30 * MIN);
  assert.equal(resolveSetting('ROOKS_PERMISSION_FORM_TIMEOUT_MS')?.source, 'default');

  assert.deepEqual(setSetting('ROOKS_PERMISSION_FORM_TIMEOUT_MS', String(20 * MIN)), { ok: true });
  assert.equal(resolveSetting('ROOKS_PERMISSION_FORM_TIMEOUT_MS')?.value, 20 * MIN);
  assert.equal(resolveSetting('ROOKS_PERMISSION_FORM_TIMEOUT_MS')?.source, 'db');

  process.env.ROOKS_PERMISSION_FORM_TIMEOUT_MS = String(10 * MIN);
  invalidateSettingsCache();
  try {
    assert.equal(resolveSetting('ROOKS_PERMISSION_FORM_TIMEOUT_MS')?.value, 10 * MIN);
    assert.equal(resolveSetting('ROOKS_PERMISSION_FORM_TIMEOUT_MS')?.source, 'env');
  } finally {
    delete process.env.ROOKS_PERMISSION_FORM_TIMEOUT_MS;
    setSetting('ROOKS_PERMISSION_FORM_TIMEOUT_MS', null);
  }
});

test('the delay depends on the tool: a form waits longer than an Allow / Deny card', () => {
  assert.equal(cardTimeoutMs('ask_user', true), 30 * MIN);
  assert.equal(cardTimeoutMs('Bash', true), 5 * MIN);
  assert.equal(cardTimeoutMs('ask_user', false), 0);
  assert.equal(cardTimeoutMs('Bash', false), 0);
});

test('an autonomous mission arms the form delay on a form and the short one on a tool card', async () => {
  dbApi.createMission('nightly', 'acme.ops', 'nightly', { channel: 'routine' });

  const form = openCard('nightly', 'ask_user', plan);
  assert.equal(form.card.timeout_ms, 30 * MIN);
  assert.equal(form.payload.expires_at, form.card.created_at + 30 * MIN);
  await form.pending;

  const tool = openCard('nightly', 'Bash', { command: 'rm -rf build' });
  assert.equal(tool.card.timeout_ms, 5 * MIN);
  assert.equal(tool.payload.expires_at, tool.card.created_at + 5 * MIN);
  await tool.pending;
});

test('a chat mission never expires, form or not, and its card carries no deadline', async () => {
  dbApi.createMission('talk', 'acme.main', 'hello', { channel: 'chat' });
  for (const [tool, input] of [['ask_user', plan], ['Bash', { command: 'ls' }]] as const) {
    const { card, payload, pending } = openCard('talk', tool, input);
    assert.equal(card.timeout_ms, 0);
    assert.equal(payload.expires_at, undefined);
    await pending;
  }
});

test('the form delay stays under the hung-turn reaper like the others', () => {
  setSetting('ROOKS_PERMISSION_FORM_TIMEOUT_MS', String(120 * MIN));
  try {
    // 80 % of the 45-minute reaper.
    assert.equal(cardTimeoutMs('ask_user', true), 36 * MIN);
  } finally {
    setSetting('ROOKS_PERMISSION_FORM_TIMEOUT_MS', null);
  }
});
