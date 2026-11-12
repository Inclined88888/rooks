/**
 * How the context crosses on a backend switch is a DECISION, taken before
 * anything is torn down — and the UI shows the user that same decision before
 * asking them to confirm. So it has to be computable without side effects,
 * and it has to obey the caller when the caller states a preference.
 *
 * The distinction that matters here: the configured threshold is a POLICY
 * (an explicit choice overrules it), while the target CLI's prompt ceiling is
 * PHYSICS (nothing overrules it — the spawn would die in E2BIG).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-switch-plan-test-'));

const { dbApi } = await import('./db.js');
const { planSwitchContext } = await import('./agent.js');
const { setSetting } = await import('./settings.js');

/** `setSetting` takes the raw string a settings form would submit. */
function threshold(tokens: number): void {
  const out = setSetting('ROOKS_SWITCH_TRANSCRIPT_MAX_TOKENS', String(tokens));
  assert.equal(out.ok, true);
}

/** A mission carrying `chars` characters of user speech. */
function missionWithTranscript(chars: number): string {
  const id = randomUUID();
  dbApi.createMission(id, 'p.main', 'plan test');
  dbApi.insertEvent(id, 'user', {
    message: { content: [{ type: 'text', text: 'x'.repeat(chars) }] },
  });
  return id;
}

{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('an empty mission has no context to hand over', async () => {
  const id = randomUUID();
  dbApi.createMission(id, 'p.main', 'empty');
  const plan = await planSwitchContext(id, 'claude', 'auto');
  assert.equal(plan.mode, 'none');
});

test('under the threshold, auto sends the whole transcript', async () => {
  threshold(80_000);
  const plan = await planSwitchContext(missionWithTranscript(400), 'claude', 'auto');
  assert.equal(plan.mode, 'transcript');
  assert.equal(plan.fitsWhole, true);
});

test('over the threshold, auto compacts — and says so', async () => {
  threshold(10);
  const plan = await planSwitchContext(missionWithTranscript(4_000), 'claude', 'auto');
  assert.equal(plan.mode, 'summary');
  assert.match(plan.reason ?? '', /threshold/);
});

test('the threshold is a policy: an explicit choice overrules it both ways', async () => {
  threshold(10);
  const big = missionWithTranscript(4_000);
  assert.equal((await planSwitchContext(big, 'claude', 'transcript')).mode, 'transcript');

  threshold(80_000);
  const small = missionWithTranscript(400);
  assert.equal((await planSwitchContext(small, 'claude', 'summary')).mode, 'summary');
});

test('a threshold of 0 means: always compact', async () => {
  threshold(0);
  const plan = await planSwitchContext(missionWithTranscript(40), 'claude', 'auto');
  assert.equal(plan.mode, 'summary');
});

test('no backend caps its prompt any more: the whole thread always fits', async () => {
  // Codex used to cap at 48 kB because its prompt travelled through argv. It
  // reads stdin now — if a dialect ever declares a ceiling again, this asserts
  // that `fitsWhole` reports the physical truth rather than the policy.
  threshold(80_000);
  const plan = await planSwitchContext(missionWithTranscript(200_000), 'codex', 'transcript');
  assert.equal(plan.fitsWhole, true);
  assert.equal(plan.mode, 'transcript');
});
