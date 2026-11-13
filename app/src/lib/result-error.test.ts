import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultErrorText, isRateLimitMessage } from './result-error.js';

/* Payloads recopiés de la base ROOKS, pas inventés. */
const GROK_QUOTA = 'You’ve reached your free Grok Build usage limit for now. '
  + 'Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok';
const CLAUDE_SESSION = 'You\'ve hit your session limit · resets 9:10pm (Europe/Paris)';

test('grok : le message vit dans un tableau `errors`', () => {
  assert.equal(
    resultErrorText({ type: 'result', is_error: true, errors: [GROK_QUOTA] }),
    GROK_QUOTA,
  );
  assert.ok(isRateLimitMessage(GROK_QUOTA));
});

test('claude : chaîne sur `error`, ou `result` court', () => {
  assert.equal(resultErrorText({ is_error: true, error: 'overloaded' }), 'overloaded');
  assert.equal(resultErrorText({ is_error: true, result: CLAUDE_SESSION }), CLAUDE_SESSION);
  assert.ok(isRateLimitMessage(CLAUDE_SESSION));
});

test('une réponse complète n’est pas prise pour une erreur', () => {
  // `result` porte le texte final du tour : le recracher doublerait la bulle
  // qui vient de l’afficher.
  assert.equal(resultErrorText({ is_error: true, result: 'x'.repeat(400) }), null);
  // Mais si le CLI a nommé l’erreur, on la garde quelle que soit sa longueur.
  assert.equal(
    resultErrorText({ is_error: true, error: 'y'.repeat(400), result: 'x'.repeat(400) }),
    'y'.repeat(400),
  );
});

test('un tour réussi ne produit aucun message', () => {
  assert.equal(resultErrorText({ is_error: false, errors: [GROK_QUOTA] }), null);
  assert.equal(resultErrorText({ type: 'result' }), null);
  assert.equal(resultErrorText(null), null);
  assert.equal(resultErrorText('boom'), null);
});

test('les formes dégradées ne font pas tomber la lecture', () => {
  assert.equal(resultErrorText({ is_error: true, errors: 'pas un tableau' }), null);
  assert.equal(resultErrorText({ is_error: true, errors: [null, 42, '  '] }), null);
  assert.equal(resultErrorText({ is_error: true, errors: ['  ', 'vrai souci'] }), 'vrai souci');
  // Plusieurs erreurs sur le même tour : toutes affichées, pas seulement la 1re.
  assert.equal(resultErrorText({ is_error: true, errors: ['a', 'b'] }), 'a · b');
});

test('panne ≠ quota : seul le second change le libellé affiché', () => {
  assert.equal(isRateLimitMessage('ENOENT: no such file or directory'), false);
  assert.equal(isRateLimitMessage('permission denied'), false);
  assert.ok(isRateLimitMessage('429 Too Many Requests'));
});
