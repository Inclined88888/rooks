/**
 * Tests des valeurs "en vigueur" affichées par le planificateur de série.
 *
 * Ce qui compte ici : une règle de repli POSÉE doit être celle qu'on lit dans
 * le formulaire. C'était tout le problème — "garder le fallback global" ne
 * disait pas ce qu'on gardait, donc le choix se faisait de mémoire.
 *
 * ROOKS_HOME est redirigé vers un dossier jetable AVANT l'import : la chaîne
 * db → agent → projects lit l'env au chargement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-series-defaults-test-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { seriesPlanDefaults } = await import('./series-plan-defaults.js');
const { dbApi } = await import('./db.js');

function mission(id: string): string {
  dbApi.createMission(id, 'test.agent', 'test plan de série');
  return id;
}

{
  const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
  // A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
  await stubCliBinaries('claude', 'codex');
  await stubCodexSignIn();
  await mountOfficialProviders();
}

test('le repli de série posé est celui qui s’affiche', () => {
  const id = mission('m-series-defaults-1');
  dbApi.setSeriesFallback(id, 'code', 'codex', 'gpt-5.6-sol');
  const defaults = seriesPlanDefaults(id, 'test.agent');
  assert.equal(defaults.code?.fallback, 'codex / gpt-5.6-sol');
});

test('le joker `*` couvre les rôles sans règle propre, jamais l’orchestrateur', () => {
  const id = mission('m-series-defaults-2');
  dbApi.setSeriesFallback(id, '*', 'codex', 'gpt-5.6-luna');
  const defaults = seriesPlanDefaults(id, 'test.agent');
  assert.equal(defaults.doc?.fallback, 'codex / gpt-5.6-luna');
  // L'orchestrateur encaisse toutes les alertes du chantier : le petit modèle
  // choisi pour les reviews ne doit pas lui être appliqué par ricochet.
  assert.notEqual(defaults.orchestrator?.fallback, 'codex / gpt-5.6-luna');
});

test('chaque rôle annonce un modèle courant, backend et slug', () => {
  const id = mission('m-series-defaults-3');
  const defaults = seriesPlanDefaults(id, 'test.agent');
  for (const role of ['orchestrator', 'mission', 'code', 'doc'] as const) {
    assert.match(String(defaults[role]?.model), /^[a-z0-9-]+ \/ .+$/);
  }
});

test('une mission inconnue ne fait pas échouer la résolution', () => {
  // Le formulaire doit s'ouvrir même si la résolution n'a rien à dire : une
  // aide à la décision manquante dégrade, une exception prive l'utilisateur du choix.
  assert.doesNotThrow(() => seriesPlanDefaults('mission-qui-n-existe-pas', 'test.agent'));
});

test('un choix de rôle déjà posé pour la série est celui qui s’affiche', () => {
  const id = mission('m-series-defaults-roles');
  dbApi.setSeriesRole(id, 'review', 'codex', 'gpt-5.6-sol');
  const defaults = seriesPlanDefaults(id, 'test.agent');
  assert.equal(defaults.review?.model, 'codex / gpt-5.6-sol');
  // Other roles of the same series keep their project/agent default.
  assert.notEqual(defaults.merge?.model, 'codex / gpt-5.6-sol');
});

test('code/review/merge annoncent le modèle de l’agent qui les exécute, pas celui de l’orchestrateur', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { agentDir } = await import('./paths.js');
  const write = (name: string, config: Record<string, unknown>) => {
    mkdirSync(agentDir(name), { recursive: true });
    writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd: TMP_HOME, project: 'defproj', ...config }));
  };
  write('defproj.main', { role: 'orchestrator', model: 'claude-sonnet-5-5' });
  write('defproj.coder', { role: 'coder', backend: 'claude', model: 'opus' });
  write('defproj.reviewer', { role: 'reviewer', backend: 'codex', model: 'gpt-5.6-sol' });
  const id = mission('m-series-defaults-role-agent');
  const defaults = seriesPlanDefaults(id, 'defproj.main');
  assert.equal(defaults.code?.model, 'claude / opus');
  assert.equal(defaults.review?.model, 'codex / gpt-5.6-sol');
  // The orchestrator keeps its own.
  assert.match(String(defaults.orchestrator?.model), /claude-sonnet-5-5/);
});
