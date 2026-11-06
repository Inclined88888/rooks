/**
 * Détection d'une limite d'usage dans le flux d'un backend.
 *
 * Ce qui est vérifié ici a un coût réel quand ça casse : une limite non
 * reconnue fait classer la mission "crash", donc morte et non reprenable,
 * alors qu'elle attend juste un quota.
 *
 * `node --test --import tsx src/rate-limit.test.ts`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rateLimitFromEvent, isRateLimitText, isExhaustedText } from './rate-limit.js';

const QUOTA_MSG =
  'You’ve reached your free Grok Build usage limit for now. '
  + 'Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok';

test('le message de quota est reconnu quel que soit le champ qui le porte', () => {
  // Forme claude/codex : une chaîne sur `error`.
  assert.ok(rateLimitFromEvent('result', { is_error: true, error: QUOTA_MSG }));
  // Forme grok : un TABLEAU `errors`. Sans cette branche, une mission
  // simplement à court de quota était classée "crash".
  assert.ok(rateLimitFromEvent('result', { is_error: true, errors: [QUOTA_MSG] }));
  // Le tableau peut mélanger du bruit et le vrai message.
  assert.ok(rateLimitFromEvent('result', {
    is_error: true,
    errors: ['tool failed', QUOTA_MSG],
  }));
});

test('la source est bien « text » : ni fenêtre ni heure de réouverture', () => {
  const hit = rateLimitFromEvent('result', { is_error: true, errors: [QUOTA_MSG] });
  assert.equal(hit?.source, 'text');
  assert.equal(hit?.window, null);
  // Un dialecte `textual` ne dit jamais QUAND : inventer une heure de reprise
  // ferait replanifier une mission sur une valeur fausse.
  assert.equal(hit?.resetsAt, null);
  assert.equal(hit?.pending, false);
});

test('un quota et un solde épuisé sont deux familles distinctes', () => {
  // Fenêtre pleine : elle se rouvrira toute seule.
  assert.equal(rateLimitFromEvent('result', { is_error: true, error: QUOTA_MSG })?.kind, 'rate_limit');
  assert.equal(
    rateLimitFromEvent('result', { is_error: true, api_error_status: 429 })?.kind,
    'rate_limit',
  );
  // Solde épuisé : rien ne se rouvre sans réapprovisionnement. Le statut
  // structuré est la détection de référence — un entier survit à une
  // reformulation du fournisseur, une regex non.
  const dry = rateLimitFromEvent('result', { is_error: true, api_error_status: 402 });
  assert.equal(dry?.kind, 'exhausted');
  assert.equal(dry?.source, 'status');
  assert.equal(dry?.resetsAt, null);
});

test('une erreur ordinaire ne se fait pas passer pour un quota', () => {
  assert.equal(rateLimitFromEvent('result', { is_error: true, errors: ['ENOENT: no such file'] }), null);
  assert.equal(rateLimitFromEvent('result', { is_error: true, errors: [] }), null);
  // Un `errors` qui n'est pas un tableau ne doit pas faire tomber la sonde.
  assert.equal(rateLimitFromEvent('result', { is_error: true, errors: 'boom' }), null);
  assert.equal(rateLimitFromEvent('result', { is_error: true, errors: [null, 42] }), null);
  // Un result SANS erreur ne s'inspecte pas.
  assert.equal(rateLimitFromEvent('result', { is_error: false, errors: [QUOTA_MSG] }), null);
});

test('les tournures usuelles des trois CLI sont couvertes', () => {
  for (const msg of [
    'You’ve reached your free Grok Build usage limit for now',
    'Claude usage limit reached, try again later',
    '429 Too Many Requests',
    'rate limit exceeded',
    'quota exceeded for this org',
  ]) {
    assert.ok(isRateLimitText(msg), `non reconnu : ${msg}`);
  }
  assert.equal(isRateLimitText('permission denied'), false);
  assert.equal(isRateLimitText(undefined), false);
});

test('le payload exact de l’incident du 2026-09-01 est reconnu comme un solde épuisé', () => {
  // Reproduit à l'octet près l'event `result` reçu cette nuit-là. Le 402 n'est
  // ni un champ ni une phrase connue : il est enfoui dans une CHAÎNE de
  // `errors[]`. Cinq missions sont mortes en 295 ms sans qu'aucun cooldown ne
  // soit posé — `backend_cooldowns` est restée vide toute la nuit.
  const payload = {
    type: 'result', subtype: 'error_during_execution', is_error: true,
    num_turns: 0, duration_ms: 295, total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    errors: ['Internal error: {\n  "message": "API error (status 402 Payment Required): '
      + 'Grok Build usage balance exhausted",\n  "http_status": 402\n}'],
  };
  const hit = rateLimitFromEvent('result', payload);
  assert.notEqual(hit, null);
  assert.equal(hit?.kind, 'exhausted');
  // Le filet textuel ne sait rien de plus : ni fenêtre, ni réouverture.
  assert.equal(hit?.source, 'text');
  assert.equal(hit?.resetsAt, null);
});

test('le vocabulaire du solde épuisé est couvert, sans avaler les erreurs voisines', () => {
  for (const msg of [
    'API error (status 402 Payment Required)',
    'Payment Required',
    'insufficient credit on this account',
    'insufficient_quota',
    'Grok Build usage balance exhausted',
    'you are out of credits',
  ]) {
    assert.ok(isExhaustedText(msg), `non reconnu : ${msg}`);
  }
  // `billing` seul ne suffit pas : contrairement à une fenêtre pleine, un
  // `exhausted` écarte le backend pour tout le compte et pour 24 h — une task
  // qui code une feature de facturation ne doit pas déclencher ça.
  assert.equal(isExhaustedText('TypeError in billing.ts'), false);
  // Même raison pour le nombre nu : `:` est une frontière de mot, donc `\b402\b`
  // matcherait le numéro de ligne de n'importe quelle stack trace posée dans
  // `errors[]`. Le 402 n'est retenu qu'accolé à son étiquette.
  assert.equal(isExhaustedText('Internal error: crash at /src/agent.ts:402:15'), false);
  assert.ok(isExhaustedText('{"http_status": 402}'));
  assert.equal(isExhaustedText('permission denied'), false);
  assert.ok(isExhaustedText('billing issue: card declined'));

  // Une phrase de solde épuisé qui contient AUSSI le mot "limit" reste un
  // solde épuisé : la reclasser en quota programmerait une reprise impossible.
  const mixed = rateLimitFromEvent('result', {
    is_error: true,
    errors: ['usage limit reached', 'payment required: balance exhausted'],
  });
  assert.equal(mixed?.kind, 'exhausted');
});

test('a model at capacity is recognised, and is not read as a quota', async () => {
  const { isOverloadedEvent } = await import('./rate-limit.js');
  // Codex, as persisted on 05/10/2026 for three dead reviews.
  const codex = {
    is_error: true,
    error: 'Selected model is at capacity. Please try a different model.',
  };
  assert.equal(isOverloadedEvent('result', codex), true);
  assert.equal(rateLimitFromEvent('result', codex), null, 'a full model is not a usage limit');
  // Anthropic: the structured status, then the error type in text.
  assert.equal(isOverloadedEvent('result', { is_error: true, api_error_status: 529 }), true);
  assert.equal(isOverloadedEvent('result', { is_error: true, errors: ['x', 'overloaded_error: Overloaded'] }), true);
  // Only an error result counts: an assistant talking about overloading does not.
  assert.equal(isOverloadedEvent('result', { is_error: false, error: 'at capacity' }), false);
  assert.equal(isOverloadedEvent('assistant', { is_error: true, error: 'at capacity' }), false);
  assert.equal(isOverloadedEvent('result', { is_error: true, error: 'TypeError: x is undefined' }), false);
});
