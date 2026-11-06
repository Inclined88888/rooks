/**
 * Tests des garde-fous d'entrée (task-guards.ts).
 *
 * `node --test --import tsx src/task-guards.test.ts` (ou `npm test`). Le module
 * testé est pur : aucun import n'ouvre la base SQLite ni ne lit le disque.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateScheduledAt,
  checkScheduledAtPlausibility,
  checkRoleAgentCwd,
  normalizeCwd,
} from './task-guards.js';

const H = 3_600_000;
/** 2026-08-05 22h45 locale : l'heure exacte de création des tasks de l'incident. */
const INCIDENT_NOW = Date.UTC(2026, 7, 5, 20, 45);

const T_2026 = new Date('2026-01-01T02:00:00Z').getTime();

test('plausibilité : null/undefined et passé proche ne déclenchent rien', () => {
  assert.equal(checkScheduledAtPlausibility(null, INCIDENT_NOW), null);
  assert.equal(checkScheduledAtPlausibility(undefined, INCIDENT_NOW), null);
  assert.equal(checkScheduledAtPlausibility(INCIDENT_NOW - H, INCIDENT_NOW), null);
});

test('plausibilité : la nuit qui vient passe sans warning', () => {
  // 22h45 → 00h30 le lendemain = 1h45. Le cas nominal.
  assert.equal(checkScheduledAtPlausibility(INCIDENT_NOW + 1.75 * H, INCIDENT_NOW), null);
  // Créer à 06h00 pour 00h00 la nuit suivante = 18h pile : limite haute légitime.
  assert.equal(checkScheduledAtPlausibility(INCIDENT_NOW + 18 * H, INCIDENT_NOW), null);
});

test('plausibilité : le décalage de 24h de l\'incident est signalé', () => {
  // Les 5 tasks visaient 00h30 la nuit du 6 au 7 : 25,75h après leur création.
  const warning = checkScheduledAtPlausibility(INCIDENT_NOW + 25.75 * H, INCIDENT_NOW);
  assert.ok(warning, 'un décalage de 25,75h doit être signalé');
  assert.match(warning, /26 h in the future/);
  assert.match(warning, /24 h shift/);
});

test('plausibilité : c\'est un avertissement, jamais un rejet', () => {
  // Une task légitime dans une semaine reste acceptée — on signale, on ne tranche pas.
  const warning = checkScheduledAtPlausibility(INCIDENT_NOW + 7 * 24 * H, INCIDENT_NOW);
  assert.ok(warning);
  assert.match(warning, /created anyway/);
  assert.equal(validateScheduledAt(INCIDENT_NOW + 7 * 24 * H).ok, true);
});

test('scheduled_at absent ou null : accepté, pas de valeur', () => {
  assert.deepEqual(validateScheduledAt(undefined), { ok: true, value: undefined });
  assert.deepEqual(validateScheduledAt(null), { ok: true, value: null });
});

test('scheduled_at en ms : accepté tel quel', () => {
  assert.deepEqual(validateScheduledAt(T_2026), { ok: true, value: T_2026 });
});

test('scheduled_at en string ISO : rejeté (le cas de l\'incident 2026-08-06)', () => {
  const r = validateScheduledAt('2026-01-01');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /milliseconds/);
  assert.equal(validateScheduledAt('2026-01-01T02:00:00Z').ok, false);
});

test('scheduled_at non fini ou non numérique : rejeté', () => {
  for (const bad of [NaN, Infinity, -Infinity, true, {}, [], '']) {
    assert.equal(validateScheduledAt(bad).ok, false, `attendu rejet pour ${JSON.stringify(bad)}`);
  }
});

test('scheduled_at en secondes : rejeté (sinon dispatch immédiat silencieux)', () => {
  const r = validateScheduledAt(Math.floor(T_2026 / 1000));
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /seconds/);
});

test('normalizeCwd : trailing slash et vide', () => {
  assert.equal(normalizeCwd('/home/user/p/'), '/home/user/p');
  assert.equal(normalizeCwd('/home/user/p'), '/home/user/p');
  assert.equal(normalizeCwd('  '), null);
  assert.equal(normalizeCwd(null), null);
  assert.equal(normalizeCwd(undefined), null);
});

const BASE = {
  slug: 'mail-watch',
  role: 'code',
  agent: 'TIMON.coder',
  agentExists: true,
  agentCwd: '/home/user/webdev/projects/legacy-os',
  projectCwd: '/home/user/webdev/projects/mail-watch',
};

test('agent d\'un autre repo affecté à un rôle : rejeté', () => {
  const err = checkRoleAgentCwd(BASE);
  assert.ok(err);
  assert.match(err!, /TIMON\.coder/);
  assert.match(err!, /mail-watch/);
});

test('cwd identiques (au trailing slash près) : accepté', () => {
  assert.equal(
    checkRoleAgentCwd({ ...BASE, agentCwd: '/home/user/webdev/projects/mail-watch/' }),
    null,
  );
});

test('force: true passe outre le mismatch', () => {
  assert.equal(checkRoleAgentCwd({ ...BASE, force: true }), null);
});

test('agent inexistant, ou cwd manquant d\'un côté : rien à vérifier', () => {
  assert.equal(checkRoleAgentCwd({ ...BASE, agentExists: false }), null);
  assert.equal(checkRoleAgentCwd({ ...BASE, agentCwd: null }), null);
  assert.equal(checkRoleAgentCwd({ ...BASE, projectCwd: null }), null);
});
