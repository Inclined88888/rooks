/**
 * Bout en bout du coupe-circuit : trois missions renvoyées instantanément
 * écartent le backend ET déplacent la série, SANS qu'aucun message d'erreur
 * ne soit lisible.
 *
 * C'est la reconstitution de la nuit du 2026-09-01, débarrassée de ce qui l'a
 * fait échouer : le payload de l'incident est repris tel quel mais vidé de son
 * `errors[]`. Si la chaîne se remet à dépendre d'une phrase de fournisseur, ces
 * tests tombent — c'est exactement leur raison d'être.
 *
 * `node --test --import tsx src/backend-breaker-chain.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-breaker-chain-test-'));
process.env.TIMON_FALLBACK_ENABLED = '1';
process.env.TIMON_FALLBACK_BACKEND = 'codex';
process.env.TIMON_BREAKER_ENABLED = '1';
process.env.TIMON_BREAKER_THRESHOLD = '3';
process.env.TIMON_BREAKER_COOLDOWN_MS = '1800000';

const { dbApi } = await import('./db.js');
const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
// A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
await stubCliBinaries('grok', 'claude', 'codex');
await stubCodexSignIn();
await mountOfficialProviders();
const { bus } = await import('./bus.js');
const { rateLimitFromEvent } = await import('./rate-limit.js');
const { sterileResultSignature, noteSterileTurn, noteProductiveTurn, resetBreakers } = await import('./backend-breaker.js');
const { noteBackendUnavailable, isBackendCoolingDown, clearBackendCooldown } =
  await import('./backend-fallback.js');
const { watchMissionComplete } = await import('./dispatcher.js');

/** Le `result` de l'incident, PRIVÉ de son message : 0 tour, 0 token, 300 ms. */
const MUTE_BOUNCE = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  duration_ms: 300,
  num_turns: 0,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
};

/** Les trois rebonds de la nuit, tels que les verrait `agent.ts`. */
function bounceThreeTimes(backend: string): void {
  for (let i = 0; i < 3; i++) {
    const signature = sterileResultSignature('result', MUTE_BOUNCE);
    assert.ok(signature, 'chaque rebond doit être reconnu sur sa seule forme');
    const trip = noteSterileTurn(backend, signature);
    if (trip) noteBackendUnavailable(trip);
  }
}

test('trois rebonds muets écartent le backend, sans aucun message à lire', () => {
  resetBreakers();
  clearBackendCooldown('grok');
  // Le préalable de tout le test : la détection par le texte ne voit RIEN ici.
  assert.equal(rateLimitFromEvent('result', MUTE_BOUNCE), null);
  assert.equal(isBackendCoolingDown('grok'), false);

  bounceThreeTimes('grok');

  const cooldown = dbApi.getBackendCooldown('grok');
  assert.equal(cooldown?.kind, 'unavailable');
  assert.equal(cooldown?.quota_window, 'circuit breaker');
  assert.equal(isBackendCoolingDown('grok'), true);
});

test('un cooldown mieux informé (402) n’est pas raccourci par le coupe-circuit', () => {
  resetBreakers();
  clearBackendCooldown('grok');
  const dry = Date.now() + 24 * 3600_000;
  dbApi.setBackendCooldown('grok', dry, 'balance exhausted', false, 'exhausted');

  bounceThreeTimes('grok');

  // Le solde épuisé sait POURQUOI ; le coupe-circuit ne sait pas. Ramener le
  // backend dans la rotation dans 30 min le remettrait dans le mur.
  const cooldown = dbApi.getBackendCooldown('grok');
  assert.equal(cooldown?.kind, 'exhausted');
  assert.equal(cooldown?.until, dry);
  clearBackendCooldown('grok');
});

test('une mission morte du coupe-circuit bascule sa série sur son repli', async () => {
  resetBreakers();
  clearBackendCooldown('grok');
  const stop = watchMissionComplete();
  try {
    const seriesId = randomUUID();
    const taskId = randomUUID();
    const missionId = randomUUID();
    dbApi.createTask(taskId, 'volet coder', 'p.coder', {
      type: 'code', seriesId, backendOverride: 'grok', modelOverride: 'grok-4.6',
    });
    dbApi.createMission(missionId, 'p.coder', 'volet coder');
    dbApi.assignTaskMission(taskId, missionId);

    bus.publish({
      kind: 'mission_complete', missionId, status: 'failed', exitCode: 1,
      reason: 'backend_unavailable',
    });

    const blocked = dbApi.getTask(taskId);
    assert.equal(blocked?.status, 'BLOCKED');
    // Cause qualifiée, et non le `crash` générique qui faisait rejouer la task
    // à l'identique sur le backend mort.
    assert.equal(blocked?.interrupted_reason, 'backend_unavailable');
    assert.ok(
      (blocked?.blocked_reason ?? '').includes('backend structurally unavailable'),
      'le motif au Kanban doit dire ce qui s’est passé',
    );

    // La bascule de série est asynchrone (import paresseux d'agent.ts).
    await new Promise((r) => setTimeout(r, 200));
    const moved = dbApi.getTask(taskId);
    assert.equal(moved?.backend_override, 'codex', 'la série doit repartir sur son repli');
    // Et la task, bloquée par l'état du BACKEND et non par son travail, est
    // remise en file plutôt que laissée à attendre un humain.
    assert.equal(moved?.status, 'PENDING');
  } finally {
    stop();
  }
});

test('un backend qui n’a jamais produit un tour n’est écarté que brièvement (TIM-0009)', () => {
  resetBreakers();
  clearBackendCooldown('grok');
  const before = Date.now();
  bounceThreeTimes('grok');
  const unproven = dbApi.getBackendCooldown('grok');
  assert.equal(unproven?.kind, 'unavailable');
  // 5 min, pas les 30 min du réglage : le testeur qui vient de corriger son
  // login ou sa version de CLI doit pouvoir réessayer sans rien réarmer.
  assert.ok(unproven!.until - before <= 5 * 60_000 + 1000, `écarté trop longtemps : ${unproven!.until - before} ms`);

  // Le même backend, une fois qu'il a produit un tour, retrouve le cooldown plein.
  resetBreakers();
  clearBackendCooldown('grok');
  noteProductiveTurn('grok');
  bounceThreeTimes('grok');
  const proven = dbApi.getBackendCooldown('grok');
  assert.ok(proven!.until - before >= 25 * 60_000, `cooldown plein attendu : ${proven!.until - before} ms`);
});
