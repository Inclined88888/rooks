/**
 * Fin du tier core — `@rooks/memory` est un module `opt` : ce que devient
 * ROOKS quand on l'éteint.
 *
 * Ce qui est protégé ici, dans l'ordre du risque :
 *   1. Le recall NE S'EXÉCUTE PLUS. C'est le piège du volet : `buildMemoryBlock`
 *      lit `dbApi` en direct, et les tables `memory_*` appartiennent à
 *      `@rooks/db` — elles restent donc parfaitement lisibles module éteint. Sans
 *      garde, éteindre la mémoire n'aurait éteint que l'écran.
 *   2. Le préambule reste BIEN FORMÉ : sa section "Mémoire ROOKS" disparaît
 *      (elle prescrit un geste dont les routes ne sont plus montées), le reste
 *      est intact et dans l'ordre.
 *   3. `dreams`, qui injecte le service `@rooks/memory`, s'éteint EN CASCADE au
 *      lieu de rester PENDING : un fiber PENDING fait sortir `auditActivation` en code
 *      2, c'est-à-dire un daemon qui refuse de démarrer parce qu'un module
 *      optionnel a été coupé.
 *
 * `ROOKS_HOME` jetable, aucun daemon, aucun bind.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { config, setConfig } = await import('./config/load.js');
await import('../tests/helpers/claude-provider.js');

const { setActiveModules, resetActiveModules, moduleActive } = await import('./kernel/module-state.js');
const { planEntries, toLoaderEntries } = await import('./kernel/registry.js');
const { CATALOG } = await import('./kernel/catalog.js');
const { buildEffectivePrompt, buildMemoryBlock, upsertAgent, loadConfig } = await import('./agent.js');
const { getBackend } = await import('./backends/index.js');
const { addMemoryRule } = await import('./memory-rule-add.js');

const MEMORY = '@rooks/memory';

/**
 * Joue "le noyau a booté avec (ou sans) la mémoire". C'est bien l'arbre réel
 * qui décide, pas la config : `setLiveDecisions` poste cet ensemble à chaque
 * boot ET à chaque bascule à chaud.
 */
function withMemory<T>(enabled: boolean, fn: () => T): T {
  const ids = CATALOG.map((m) => m.id).filter((id) => enabled || id !== MEMORY);
  setActiveModules(ids);
  try { return fn(); } finally { resetActiveModules(); }
}

/** Bascule `modules['@rooks/memory']` dans la config en mémoire. */
function withMemoryConfig<T>(enabled: boolean, fn: () => T): T {
  const before = config();
  setConfig({ ...before, modules: { ...before.modules, [MEMORY]: enabled } });
  try { return fn(); } finally { setConfig(before); }
}

test('module éteint : aucune règle n\'est rappelée, même si la table en contient', () => {
  const agent = 'memoire-optionnelle';
  upsertAgent({ name: agent, system_prompt: '# temoin\n', config: { cwd: process.cwd(), project: 'rooks-temoin' } });
  // La règle est écrite EN BASE : c'est bien le module, pas la donnée, qu'on
  // éteint. Rallumer doit tout retrouver.
  addMemoryRule({ scope: 'project', project: 'rooks-temoin', tier: 'core', kind: 'pitfall', text: 'temoin-de-recall-memoire' });
  const cfg = loadConfig(agent);

  const on = withMemory(true, () => buildMemoryBlock(agent, cfg, 'temoin de recall'));
  assert.match(on, /temoin-de-recall-memoire/, 'module allumé : la règle est bien rappelée');

  const off = withMemory(false, () => buildMemoryBlock(agent, cfg, 'temoin de recall'));
  assert.equal(off, '', 'module éteint : pas de bloc mémoire du tout');
});

test('module éteint : le préambule du spawn est bien formé, sans sa section mémoire', () => {
  const agent = 'memoire-optionnelle-preambule';
  upsertAgent({ name: agent, system_prompt: '# temoin\n', config: { cwd: process.cwd() } });
  const cfg = loadConfig(agent);
  const backend = getBackend('claude');

  const off = withMemory(false, () => buildEffectivePrompt(agent, cfg, backend, 'une mission quelconque'));
  assert.match(off, /# Runtime context — Rooks/, 'la tête du préambule reste');
  assert.match(off, /## Asking the user — hard rule/, 'la queue du préambule reste');
  // Le préambule ne parle que de Rooks : la commande de test est celle de
  // l'utilisateur, elle vit dans ses règles mémoire ou l'AGENTS.md du projet.
  assert.doesNotMatch(off, /npm test/);
  assert.doesNotMatch(off, /## Rooks memory/, 'la section mémoire est retirée');
  assert.doesNotMatch(off, /rooks memory rule add/, 'plus aucun geste mémoire prescrit');
  assert.doesNotMatch(off, /🧠/, 'pas de bloc de rappel injecté');
  // Ordre : la queue suit la tête sans trou ni doublon.
  assert.ok(off.indexOf('# Runtime context — Rooks') < off.indexOf('## Asking the user — hard rule'));

  const on = withMemory(true, () => buildEffectivePrompt(agent, cfg, backend, 'une mission quelconque'));
  assert.match(on, /## Rooks memory/, 'module allumé : la section revient');
  assert.ok(on.length > off.length);
});

test('hors noyau booté, tout est réputé actif — la CLI et les tests ne changent pas de comportement', () => {
  resetActiveModules();
  assert.equal(moduleActive(MEMORY), true, 'aucun noyau n\'a parlé : on ne coupe rien');
  assert.equal(withMemory(false, () => moduleActive(MEMORY)), false);
  assert.equal(withMemory(true, () => moduleActive(MEMORY)), true);
});

test('mémoire éteinte : dreams s\'éteint avec elle plutôt que de bloquer le boot', () => {
  const decisions = withMemoryConfig(false, () => planEntries(CATALOG, {
    config: config(),
    capabilities: ['systemd', 'containers', 'traefik', 'git', 'grepai', 'uvx', 'gui'],
    licensed: CATALOG.filter((m) => m.licensed).map((m) => m.id),
  }));
  const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
  assert.equal(byId['@rooks/memory'].disabled, true);
  assert.equal(byId['@rooks/dreams'].reason, 'depends on @rooks/memory, which is disabled');
  // Le noyau ne bouge pas : éteindre la mémoire ne doit rien coûter d'autre.
  assert.equal(byId['@rooks/missions'].disabled, false);
  assert.equal(byId['@rooks/agents'].disabled, false);

  // Ce que le loader recevra : `@rooks/dreams` est marqué `disabled`, donc Cordis ne
  // l'instancie pas et il n'y a AUCUN fiber à laisser PENDING. C'est ce lien
  // précis qui évite le `process.exit(2)` de l'audit d'activation.
  const entries = toLoaderEntries(decisions);
  assert.equal(entries.find((e) => e.id === '@rooks/dreams')?.disabled, true);
  assert.equal(entries.find((e) => e.id === '@rooks/memory')?.disabled, true);
});
