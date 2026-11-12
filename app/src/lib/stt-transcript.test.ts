import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fusionnerSegments, lireResultats } from './stt-transcript';

const res = (segments: Array<[string, boolean]>) =>
  segments.map(([transcript, isFinal]) => ({ 0: { transcript }, isFinal }));

test('segments disjoints : simple concaténation', () => {
  assert.equal(fusionnerSegments(['ok je fais', 'un test de voix']), 'ok je fais un test de voix');
});

test('moteur qui réécrit la phrase entière : une seule copie', () => {
  const etapes = ['ok', 'ok je', 'ok je fais', 'ok je fais un nouveau test de voix'];
  assert.equal(fusionnerSegments(etapes), 'ok je fais un nouveau test de voix');
});

test('la ponctuation et la casse ne cassent pas la détection de réécriture', () => {
  assert.equal(fusionnerSegments(['ok je', 'OK, je fais.']), 'OK, je fais.');
});

test('relivraison à l’identique ignorée', () => {
  assert.equal(fusionnerSegments(['bonjour Alice', 'bonjour Alice']), 'bonjour Alice');
});

test('segment déjà contenu en fin de texte ignoré', () => {
  assert.equal(fusionnerSegments(['ok je fais un test', 'un test']), 'ok je fais un test');
});

test('recouvrement partiel : seule la queue inédite est collée', () => {
  assert.equal(
    fusionnerSegments(['ok je fais un test', 'un test de voix']),
    'ok je fais un test de voix',
  );
});

test('entrées vides ignorées', () => {
  assert.equal(fusionnerSegments(['', null, '  ', 'ok', undefined]), 'ok');
});

test('lireResultats sépare définitif et provisoire, sans doublon', () => {
  const r = lireResultats(
    res([
      ['ok', true],
      ['ok je fais', true],
      ['ok je fais un', false],
    ]),
  );
  assert.equal(r.final, 'ok je fais');
  assert.equal(r.interim, 'ok je fais un');
});

test('lireResultats lit tous les résultats, pas seulement les derniers', () => {
  const r = lireResultats(
    res([
      ['bonjour', true],
      ['comment ça va', false],
    ]),
  );
  assert.equal(r.final, 'bonjour');
  assert.equal(r.interim, 'comment ça va');
});

test('le texte envoyé à l’agent ne répète aucun mot', () => {
  const acquis = 'ok je fais';
  const session = 'ok je fais un nouveau test de voix pour voir comment ça marche';
  const envoye = fusionnerSegments([acquis, session]);
  assert.equal(envoye, session);
});
