/**
 * Tests de la sélection par cadence (reconcile.ts).
 *
 * `node --test --import tsx src/reconcile.test.ts` (ou `npm test`). On teste la
 * fonction pure `selectRules` : importer le registre réel tirerait dispatcher.js
 * et ouvrirait la base SQLite.
 *
 * L'enjeu couvert ici n'est pas cosmétique. Une règle qui NOTIFIE l'utilisateur
 * (`merge-without-sha`) doit rester strictement `boot` : la passer en périodique
 * renverrait la même notification toutes les 2 minutes.
 */
// Isole ROOKS_HOME AVANT tout module qui touche à l'état ROOKS (cf. test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRules, type ReconcileCadence } from './reconcile.js';

function rule(name: string, cadence: ReconcileCadence) {
  return { name, cadence };
}

test('la passe de boot joue les règles boot et both, jamais les interval seules', () => {
  const rules = [
    rule('au-boot', 'boot'),
    rule('periodique', 'interval'),
    rule('les-deux', 'both'),
  ];
  assert.deepEqual(
    selectRules(rules, 'boot').map((r) => r.name),
    ['au-boot', 'les-deux'],
  );
});

test('la passe périodique ne rejoue jamais une règle boot-only', () => {
  const rules = [
    rule('au-boot', 'boot'),
    rule('periodique', 'interval'),
    rule('les-deux', 'both'),
  ];
  const selected = selectRules(rules, 'interval').map((r) => r.name);
  assert.deepEqual(selected, ['periodique', 'les-deux']);
  assert.ok(!selected.includes('au-boot'), 'une règle boot-only qui notifie spammerait l\'utilisateur');
});

test('registre vide : aucune sélection, aucune erreur', () => {
  assert.deepEqual(selectRules([], 'boot'), []);
  assert.deepEqual(selectRules([], 'interval'), []);
});

test('une règle both est jouée dans les deux passes', () => {
  const rules = [rule('les-deux', 'both')];
  assert.equal(selectRules(rules, 'boot').length, 1);
  assert.equal(selectRules(rules, 'interval').length, 1);
});

test('une règle enregistrée par un module rejoint la liste, et son retrait l\'en sort', async () => {
  // L'intérêt du registre : `reconcile.ts` n'importe plus grepai ni
  // browser-sessions, donc une installation sans ces modules n'a pas à les
  // charger pour se réconcilier. Le prix serait une règle qui survit à son
  // module — d'où la vérification du retrait.
  const { registerReconcileRule, listReconcileRules } = await import('./reconcile.js');
  const before = listReconcileRules().length;
  const remove = registerReconcileRule({
    name: 'temoin',
    invariant: 'Rien du tout — règle de test.',
    cadence: 'interval',
    run: () => { /* no-op */ },
  });
  assert.equal(listReconcileRules().length, before + 1);
  assert.ok(listReconcileRules().some((r) => r.name === 'temoin'));
  remove();
  assert.equal(listReconcileRules().length, before);
  assert.ok(!listReconcileRules().some((r) => r.name === 'temoin'));
});
