/**
 * Circuit breaker: three sterile turns in a row sideline a backend WITHOUT
 * anyone reading its error message.
 *
 * The reference payload is the one from the night of 2026-09-01 (grok out of
 * credit), stripped of its `errors[]`: what is verified here is precisely that
 * the sentence is not needed. Same shape, same verdict, whatever the provider
 * writes — that is what makes this net catch the `Not signed in` incident too.
 *
 * `node --test --import tsx src/backend-breaker.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-breaker-test-'));
process.env.ROOKS_BREAKER_ENABLED = '1';
process.env.ROOKS_BREAKER_THRESHOLD = '3';
process.env.ROOKS_BREAKER_WINDOW_MS = '600000';
process.env.ROOKS_BREAKER_STERILE_MS = '2000';

const {
  sterileResultSignature, sterileExitSignature, noteSterileTurn,
  noteProductiveTurn, breakerFailures, resetBreakers, isAuthFailureEvent,
} = await import('./backend-breaker.js');

/** The incident's `result`, WITHOUT its error message: the breaker must not
 *  need it. Only the shape is left. */
const bounce = (over: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  duration_ms: 295,
  num_turns: 0,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  ...over,
});

test('un result stérile est reconnu sans lire le moindre message d’erreur', () => {
  assert.equal(sterileResultSignature('result', bounce()), '0 turn / 0 token / 295 ms');
});

test('trois results stériles consécutifs déclenchent le coupe-circuit, pas deux', () => {
  resetBreakers();
  const sig = sterileResultSignature('result', bounce())!;
  assert.equal(noteSterileTurn('grok', sig, 1_000), null);
  assert.equal(noteSterileTurn('grok', sig, 2_000), null);
  const trip = noteSterileTurn('grok', sig, 3_000);
  assert.ok(trip, 'le seuil de 3 doit déclencher');
  assert.equal(trip.backend, 'grok');
  assert.equal(trip.failures, 3);
  assert.equal(trip.threshold, 3);
  assert.equal(trip.spanMs, 2_000);
  assert.equal(trip.signature, '0 turn / 0 token / 295 ms');
  // Au-delà du seuil, chaque nouveau rebond redéclenche : la 4e mission qui
  // meurt mérite la même qualification que la 3e.
  assert.ok(noteSterileTurn('grok', sig, 4_000));
});

test('les compteurs sont par backend : grok à sec n’écarte pas claude', () => {
  resetBreakers();
  const sig = '0 turn / 0 token / 295 ms';
  noteSterileTurn('grok', sig, 1_000);
  noteSterileTurn('grok', sig, 2_000);
  assert.equal(noteSterileTurn('claude', sig, 3_000), null);
  assert.equal(breakerFailures('claude', 3_000), 1);
  assert.ok(noteSterileTurn('grok', sig, 3_000));
});

test('un tour qui aboutit remet le compteur à zéro', () => {
  resetBreakers();
  const sig = '0 turn / 0 token / 295 ms';
  noteSterileTurn('grok', sig, 1_000);
  noteSterileTurn('grok', sig, 2_000);
  noteProductiveTurn('grok');
  assert.equal(breakerFailures('grok', 2_500), 0);
  assert.equal(noteSterileTurn('grok', sig, 3_000), null);
});

test('la fenêtre glisse : deux échecs d’il y a une heure ne comptent plus', () => {
  resetBreakers();
  const sig = '0 turn / 0 token / 295 ms';
  noteSterileTurn('grok', sig, 0);
  noteSterileTurn('grok', sig, 1_000);
  // Une heure plus tard, la fenêtre de 10 min a tout oublié.
  assert.equal(noteSterileTurn('grok', sig, 3_600_000), null);
  assert.equal(breakerFailures('grok', 3_600_000), 1);
});

test('un tour productif n’est jamais stérile, si vite qu’il finisse', () => {
  // Un token produit prouve que le fournisseur a travaillé.
  assert.equal(sterileResultSignature('result', bounce({ usage: { input_tokens: 12, output_tokens: 0 } })), null);
  // Un coût aussi.
  assert.equal(sterileResultSignature('result', bounce({ total_cost_usd: 0.004 })), null);
  // A real one-turn answer: tokens produced, so the turn counts as work.
  assert.equal(sterileResultSignature('result', bounce({
    num_turns: 1, usage: { input_tokens: 5_000, output_tokens: 180 }, total_cost_usd: 0.02,
  })), null);
  // More than one turn means the CLI went round the loop: not a bounce.
  assert.equal(sterileResultSignature('result', bounce({ num_turns: 2 })), null);
  // Trop long pour être un rebond.
  assert.equal(sterileResultSignature('result', bounce({ duration_ms: 240_000 })), null);
  // Un succès stérile ne dit rien de la santé du backend.
  assert.equal(sterileResultSignature('result', bounce({ is_error: false })), null);
});

/** The claude CLI's `result` on an expired OAuth session (mission 49c90448,
 *  2026-09-17), fields kept as recorded. */
const AUTH_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  num_turns: 1,
  duration_ms: 45,
  duration_api_ms: 0,
  total_cost_usd: 0,
  terminal_reason: 'api_error',
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
};

test('un rebond à num_turns: 1 sans token est stérile (OAuth expirée, claude)', () => {
  assert.equal(sterileResultSignature('result', AUTH_RESULT), '1 turn / 0 token / 45 ms');
  // With no usage block, the zero tokens would be assumed rather than observed.
  const { usage, ...noUsage } = AUTH_RESULT;
  assert.equal(sterileResultSignature('result', noUsage), null);
});

test('un échec d’auth se lit sur le champ structuré, jamais sur le texte', () => {
  const synthetic = {
    type: 'assistant',
    error: 'authentication_failed',
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] },
  };
  assert.equal(isAuthFailureEvent('assistant', synthetic), true);
  // The same sentence without the code proves nothing: a model may well write it.
  const { error, ...textOnly } = synthetic;
  assert.equal(isAuthFailureEvent('assistant', textOnly), false);
  assert.equal(isAuthFailureEvent('assistant', { ...synthetic, error: 'server_error' }), false);
  assert.equal(isAuthFailureEvent('result', synthetic), false);
});

test('un échec d’auth déclenche au premier rebond, un rebond muet non', () => {
  resetBreakers();
  const sig = sterileResultSignature('result', AUTH_RESULT)!;
  assert.equal(noteSterileTurn('claude', sig, 1_000), null, 'a shapeless bounce still needs the threshold');
  resetBreakers();
  const trip = noteSterileTurn('claude', sig, 1_000, 'auth');
  assert.ok(trip, 'an authentication failure does not heal: one is enough');
  assert.equal(trip.cause, 'auth');
  assert.equal(trip.threshold, 1);
});

test('un dialecte muet sur num_turns ou duration_ms n’est jamais lu comme un rebond', () => {
  // Champ absent ≠ zéro : sans cette règle, tout backend qui ne remonte pas
  // ces compteurs serait écarté au bout de trois tours parfaitement sains.
  const { num_turns, ...noTurns } = bounce();
  assert.equal(sterileResultSignature('result', noTurns), null);
  const { duration_ms, ...noDuration } = bounce();
  assert.equal(sterileResultSignature('result', noDuration), null);
  assert.equal(sterileResultSignature('assistant', bounce()), null);
  assert.equal(sterileResultSignature('result', null), null);
});

test('un process mort avant son premier result compte aussi comme un rebond', () => {
  assert.equal(sterileExitSignature(300), 'no result / 300 ms');
  assert.equal(sterileExitSignature(240_000), null);
});
