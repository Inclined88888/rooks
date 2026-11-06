/**
 * `listMissions` doit honorer son filtre de statut.
 *
 * Ce qu'on protège : dans la nuit du 2026-08-22, `/api/missions?status=running`
 * ignorait le paramètre en silence et renvoyait les 100 dernières missions tous
 * statuts confondus. L'agent qui diagnostiquait la saturation du cap global y a
 * lu "100 missions running" là où il y en avait 11, et a conclu à une armée de
 * zombies inexistante — le vrai bug (des process de chat jamais reapés) est resté
 * invisible plusieurs heures. Un filtre ignoré ment mieux qu'une erreur.
 *
 * `node --test --import tsx src/mission-list-filter.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-filter-test-'));

const { dbApi } = await import('./db.js');

/** Crée une mission, et la finalise si un statut terminal est demandé. */
function mission(agent: string, status: 'running' | 'completed' | 'failed'): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, `mission ${status}`);
  if (status !== 'running') dbApi.finishMission(id, status, status === 'failed' ? 1 : 0);
  return id;
}

const aliveA = mission('alpha.main', 'running');
const aliveB = mission('beta.main', 'running');
mission('alpha.main', 'completed');
mission('alpha.main', 'failed');
mission('beta.main', 'completed');

test('status=running ne rend que les missions running', () => {
  const rows = dbApi.listMissions(100, undefined, 'running');
  assert.deepEqual(new Set(rows.map((m) => m.id)), new Set([aliveA, aliveB]));
});

test('sans filtre, tous les statuts remontent — le comportement historique est préservé', () => {
  assert.equal(dbApi.listMissions(100).length, 5);
});

test('le filtre de statut se combine avec le filtre d’agent, sans en écraser un', () => {
  const rows = dbApi.listMissions(100, ['alpha.main'], 'running');
  assert.deepEqual(rows.map((m) => m.id), [aliveA]);
});

test('un statut sans aucune mission rend une liste vide, pas la liste entière', () => {
  assert.deepEqual(dbApi.listMissions(100, undefined, 'terminated'), []);
});
