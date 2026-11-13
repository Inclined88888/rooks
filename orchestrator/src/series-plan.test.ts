/**
 * Tests du contrat "plan de série" (series-plan.ts).
 *
 * `node --test --import tsx src/series-plan.test.ts`. Seules les tables de
 * correspondance et les validateurs sont exercés — aucun agent, aucune task.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `series-plan.ts` lit la liste autoritative des pipelines et des types de task
// dans `db.ts`, qui ouvre SQLite à l'import. ROOKS_HOME doit donc pointer sur un
// dossier jetable AVANT l'import dynamique, sinon la suite écrirait dans la
// base de production.
process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-series-plan-test-'));
const {
  validateSeriesPlanForm,
  validateSeriesPlanAnswer,
  seriesPlanCommands,
  fallbackScopeForRole,
  seriesPlanPipelineDrift,
  planGroupNames,
  ROLES_BY_MODE,
  SERIES_PLAN_MODES,
  MAX_GROUPS,
} = await import('./series-plan.js');
type SeriesPlanAnswer = import('./series-plan.js').SeriesPlanAnswer;

const form = { kind: 'series_plan', chantier: 'Refonte du formulaire', volets: [{ title: 'front' }] };

test('formulaire valide accepté', () => {
  assert.equal(validateSeriesPlanForm(form), null);
});

test('formulaire : défauts nommés', () => {
  assert.match(String(validateSeriesPlanForm({ ...form, kind: 'autre' })), /kind/);
  assert.match(String(validateSeriesPlanForm({ ...form, chantier: '  ' })), /chantier/);
  assert.match(String(validateSeriesPlanForm({ ...form, volets: [] })), /empty/);
  assert.match(String(validateSeriesPlanForm({ ...form, volets: [{}] })), /title/);
  const trop = { ...form, volets: Array.from({ length: 13 }, (_, i) => ({ title: `v${i}` })) };
  assert.match(String(validateSeriesPlanForm(trop)), /maximum 12/);
});

test('réponse : rôle hors du mode refusé', () => {
  // Un reviewer réglé sur un pipeline sans review = un réglage mort, jamais
  // appliqué. Le refuser vaut mieux que le laisser croire qu'il compte.
  const answer = { mode: 'kanban-code-self', roles: { review: { fallbackBackend: 'codex' } } };
  assert.match(String(validateSeriesPlanAnswer(answer)), /is outside mode/);
});

test('réponse : repli à moitié renseigné refusé', () => {
  const answer = { mode: 'kanban-full', roles: { code: { fallbackModel: 'gpt-5.6-sol' } } };
  assert.match(String(validateSeriesPlanAnswer(answer)), /fallbackBackend/);
});

test('réponse : mode inconnu refusé', () => {
  assert.match(String(validateSeriesPlanAnswer({ mode: 'kanban-turbo', roles: {} })), /unknown mode/);
});

test('réponse minimale acceptée (tout hérite)', () => {
  assert.equal(validateSeriesPlanAnswer({ mode: 'sequential-here', roles: {} }), null);
});

test('la mission neuve pose son repli sur le scope orchestrator', () => {
  assert.equal(fallbackScopeForRole('mission'), 'orchestrator');
  assert.equal(fallbackScopeForRole('orchestrator'), 'orchestrator');
  assert.equal(fallbackScopeForRole('code'), 'code');
  assert.equal(fallbackScopeForRole('doc'), 'doc');
});

test('commandes : replis puis tasks, une par volet', () => {
  const answer: SeriesPlanAnswer = {
    mode: 'kanban-full',
    roles: {
      orchestrator: { fallbackBackend: 'codex', fallbackModel: 'gpt-5.6-sol' },
      code: { backend: 'claude', model: 'opus', fallbackBackend: 'codex', fallbackModel: 'gpt-5.6-sol' },
    },
  };
  const cmds = seriesPlanCommands(answer, [{ title: 'front' }, { title: 'back' }]);
  assert.equal(cmds[0], 'rooks series fallback set --scope orchestrator --backend codex --model gpt-5.6-sol');
  assert.equal(cmds[1], 'rooks series fallback set --scope code --backend codex --model gpt-5.6-sol');
  const tasks = cmds.filter((c) => c.includes('task create'));
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((c) => c.includes('--pipeline full')));
  // The coder's pick is a series role now: it also reaches the code iterations.
  assert.ok(tasks.every((c) => !c.includes('--model') && !c.includes('--backend')));
  assert.ok(cmds.includes('rooks series role set --scope code --backend claude --model opus'));
  assert.ok(cmds.indexOf('rooks series role set --scope code --backend claude --model opus') < cmds.indexOf(tasks[0]!));
});

test('commandes : les choix review/merge/doc sont des overrides de série posés avant les tasks', () => {
  const rolesFile = join(process.env.ROOKS_HOME!, 'projects', 'acme', 'roles.json');
  mkdirSync(join(process.env.ROOKS_HOME!, 'projects', 'acme'), { recursive: true });
  const rolesBefore = JSON.stringify({ review: { agent: 'acme.reviewer', backend: 'claude', model: 'sonnet' } });
  writeFileSync(rolesFile, rolesBefore);
  const answer: SeriesPlanAnswer = {
    mode: 'kanban-full',
    roles: {
      orchestrator: { backend: 'claude', model: 'opus' },
      review: { backend: 'codex', model: 'gpt-5.6-sol' },
      merge: { model: 'sonnet' },
      doc: { backend: 'claude', model: 'haiku', fallbackBackend: 'codex' },
    },
  };
  const cmds = seriesPlanCommands(answer, [{ title: 'front' }]);
  const firstTask = cmds.findIndex((c) => c.includes('task create'));
  const roles = cmds.filter((c) => c.startsWith('rooks series role set'));
  assert.deepEqual(roles, [
    'rooks series role set --scope review --backend codex --model gpt-5.6-sol',
    'rooks series role set --scope merge --model sonnet',
    'rooks series role set --scope doc --backend claude --model haiku',
  ]);
  assert.ok(roles.every((c) => cmds.indexOf(c) < firstTask));
  // The pilot is a mission, not a task type: nothing to set at series level.
  assert.ok(!cmds.some((c) => c.includes('--scope orchestrator') && c.includes('series role')));
  // Nothing in the plan writes project roles.
  assert.ok(!cmds.some((c) => c.includes('project set-role')));
  assert.equal(readFileSync(rolesFile, 'utf8'), rolesBefore);
});

test('commandes : seul un rôle réglé produit un override de série', () => {
  const cmds = seriesPlanCommands({ mode: 'kanban-code-self', roles: { code: { model: 'opus' } } }, [{ title: 'a' }]);
  assert.deepEqual(cmds.filter((c) => c.includes('series role')), ['rooks series role set --scope code --model opus']);
});

test('commandes : le merge groupé ajoute sa task de consolidation', () => {
  const cmds = seriesPlanCommands({ mode: 'kanban-code-group', roles: {} }, [{ title: 'a' }]);
  assert.equal(cmds.filter((c) => c.includes('--type merge')).length, 1);
  assert.ok(cmds.every((c) => c.includes('--group-id')));
});

test('commandes : un mode séquentiel ne crée aucune task', () => {
  assert.deepEqual(seriesPlanCommands({ mode: 'sequential-here', roles: {} }, [{ title: 'a' }]), []);
});

test('un titre de volet à quote ne casse pas la commande', () => {
  const cmds = seriesPlanCommands({ mode: 'kanban-full', roles: {} }, [{ title: "l'index" }]);
  assert.ok(cmds[0].includes(`'l'\\''index'`));
});

test('chaque mode déclare ses rôles et un pipeline existant', () => {
  for (const mode of SERIES_PLAN_MODES) {
    assert.ok(ROLES_BY_MODE[mode].length > 0, `mode ${mode} sans rôle`);
  }
  assert.equal(seriesPlanPipelineDrift(), null);
});

/* ── Groupes de volets (TODO #433) ──────────────────────────────────────────
 * Un volet peut porter un `group` ; la réponse règle alors les modèles PAR
 * GROUPE, les réglages globaux par rôle restant le défaut.
 * ───────────────────────────────────────────────────────────────────────── */

const grouped = [
  { title: 'typo', group: 'simple' },
  { title: 'libellés', group: 'simple' },
  { title: 'refonte du dispatcher', group: 'complexe' },
  { title: 'doc', description: 'sans groupe' },
];

test('formulaire : groupes acceptés, noms distincts dans l\'ordre des volets', () => {
  assert.equal(validateSeriesPlanForm({ ...form, volets: grouped }), null);
  assert.deepEqual(planGroupNames(grouped), ['simple', 'complexe']);
  assert.deepEqual(planGroupNames([{ title: 'a' }]), []);
});

test('formulaire : nom de groupe vide, non textuel ou trop long refusé', () => {
  assert.match(String(validateSeriesPlanForm({ ...form, volets: [{ title: 'a', group: '  ' }] })), /group/);
  assert.match(String(validateSeriesPlanForm({ ...form, volets: [{ title: 'a', group: 3 }] })), /group/);
  const long = { ...form, volets: [{ title: 'a', group: 'g'.repeat(61) }] };
  assert.match(String(validateSeriesPlanForm(long)), /maximum 60/);
  assert.equal(validateSeriesPlanForm({ ...form, volets: [{ title: 'a', group: 'g'.repeat(60) }] }), null);
});

test('formulaire : caractère de contrôle dans un nom de groupe refusé', () => {
  // `seriesPlanCommands` met le nom entre apostrophes : un retour à la ligne y
  // survivrait et couperait la commande que l'agent recopie.
  for (const group of ['a\nb', 'a\rb', 'tab\there', 'nul\u0000', 'del\u007f', '\u001b[0m']) {
    assert.match(String(validateSeriesPlanForm({ ...form, volets: [{ title: 'a', group }] })), /control character/, JSON.stringify(group));
  }
  // Les lettres accentuées et les espaces internes restent des noms valides.
  assert.equal(validateSeriesPlanForm({ ...form, volets: [{ title: 'a', group: 'très simple' }] }), null);
});

test('formulaire : trop de groupes distincts refusé', () => {
  const many = Array.from({ length: MAX_GROUPS + 1 }, (_, i) => ({ title: `v${i}`, group: `g${i}` }));
  assert.match(String(validateSeriesPlanForm({ ...form, volets: many })), new RegExp(`maximum ${MAX_GROUPS}`));
  // Le même nom répété ne compte qu'une fois.
  const repeated = Array.from({ length: 10 }, (_, i) => ({ title: `v${i}`, group: `g${i % MAX_GROUPS}` }));
  assert.equal(validateSeriesPlanForm({ ...form, volets: repeated }), null);
});

test('réponse : un groupe absent du formulaire émis est refusé', () => {
  const answer = { mode: 'kanban-full', roles: {}, groups: { fantôme: { code: { model: 'haiku' } } } };
  assert.match(String(validateSeriesPlanAnswer(answer, ['simple', 'complexe'])), /unknown group: fantôme/);
  // Sans liste de groupes connus, aucun groupe n'est connu.
  assert.match(String(validateSeriesPlanAnswer(answer)), /unknown group/);
  assert.equal(validateSeriesPlanAnswer({ ...answer, groups: { simple: { code: { model: 'haiku' } } } }, planGroupNames(grouped)), null);
});

test('réponse : orchestrator et mission ne se règlent pas par groupe', () => {
  const groups = ['simple'];
  const orch = { mode: 'kanban-full', roles: {}, groups: { simple: { orchestrator: { model: 'opus' } } } };
  assert.match(String(validateSeriesPlanAnswer(orch, groups)), /`orchestrator` is not set per group/);
  const mission = { mode: 'sequential-new-mission', roles: {}, groups: { simple: { mission: { model: 'opus' } } } };
  assert.match(String(validateSeriesPlanAnswer(mission, groups)), /`mission` is not set per group/);
  const unknown = { mode: 'kanban-full', roles: {}, groups: { simple: { chore: { model: 'opus' } } } };
  assert.match(String(validateSeriesPlanAnswer(unknown, groups)), /unknown role: chore/);
});

test('réponse : rôle de groupe hors du mode refusé', () => {
  const answer = { mode: 'kanban-code-self', roles: {}, groups: { simple: { review: { model: 'sonnet' } } } };
  assert.match(String(validateSeriesPlanAnswer(answer, ['simple'])), /group `simple`: role `review` is outside mode/);
});

test('réponse : repli de groupe à moitié renseigné refusé', () => {
  const answer = { mode: 'kanban-full', roles: {}, groups: { simple: { code: { fallbackModel: 'gpt-5.6-sol' } } } };
  assert.match(String(validateSeriesPlanAnswer(answer, ['simple'])), /group `simple`, role `code`: `fallbackModel` without `fallbackBackend`/);
  assert.match(String(validateSeriesPlanAnswer({ mode: 'kanban-full', roles: {}, groups: 'simple' }, ['simple'])), /`groups`/);
  assert.match(String(validateSeriesPlanAnswer({ mode: 'kanban-full', roles: {}, groups: { simple: 3 } }, ['simple'])), /group `simple`/);
});

test('commandes : sans groupe, EXACTEMENT les commandes d\'avant', () => {
  const answer: SeriesPlanAnswer = {
    mode: 'kanban-full',
    roles: {
      orchestrator: { fallbackBackend: 'codex', fallbackModel: 'gpt-5.6-sol' },
      code: { backend: 'claude', model: 'opus', fallbackBackend: 'codex', fallbackModel: 'gpt-5.6-sol' },
      review: { model: 'sonnet' },
    },
  };
  const expected = [
    'rooks series fallback set --scope orchestrator --backend codex --model gpt-5.6-sol',
    'rooks series fallback set --scope code --backend codex --model gpt-5.6-sol',
    'rooks series role set --scope code --backend claude --model opus',
    'rooks series role set --scope review --model sonnet',
    "rooks task create --type code --pipeline full --title front --description '<part brief>'",
    "rooks task create --type code --pipeline full --title back --description '<part brief>'",
  ];
  assert.deepEqual(seriesPlanCommands(answer, [{ title: 'front' }, { title: 'back' }]), expected);
  // Un `groups` vide ou sans réglage ne change rien non plus.
  assert.deepEqual(seriesPlanCommands({ ...answer, groups: {} }, [{ title: 'front' }, { title: 'back' }]), expected);
  assert.ok(!seriesPlanCommands(answer, [{ title: 'front' }]).some((c) => c.includes('--group') || c.includes('--plan-group')));
});

test('commandes : réglages de groupe après les globaux, tasks avec --plan-group', () => {
  const answer: SeriesPlanAnswer = {
    mode: 'kanban-full',
    roles: { code: { backend: 'claude', model: 'opus' } },
    groups: {
      simple: { code: { backend: 'claude', model: 'haiku', fallbackBackend: 'codex', fallbackModel: 'gpt-5.4-mini' }, review: { model: 'sonnet' } },
      complexe: {},
    },
  };
  const cmds = seriesPlanCommands(answer, grouped);
  assert.deepEqual(cmds, [
    'rooks series role set --scope code --backend claude --model opus',
    'rooks series fallback set --scope code --group simple --backend codex --model gpt-5.4-mini',
    'rooks series role set --scope code --group simple --backend claude --model haiku',
    'rooks series role set --scope review --group simple --model sonnet',
    "rooks task create --type code --pipeline full --plan-group simple --title typo --description '<part brief>'",
    "rooks task create --type code --pipeline full --plan-group simple --title 'libellés' --description '<part brief>'",
    "rooks task create --type code --pipeline full --plan-group complexe --title 'refonte du dispatcher' --description '<part brief>'",
    "rooks task create --type code --pipeline full --title doc --description '<part brief>'",
  ]);
});

test('commandes : un nom de groupe à espace ou quote est cité', () => {
  const volets = [{ title: 'a', group: "l'UI simple" }];
  const answer: SeriesPlanAnswer = { mode: 'kanban-code-group', roles: {}, groups: { "l'UI simple": { code: { model: 'haiku' } } } };
  const cmds = seriesPlanCommands(answer, volets);
  assert.ok(cmds.includes(`rooks series role set --scope code --group 'l'\\''UI simple' --model haiku`));
  assert.ok(cmds.some((c) => c.includes(`--group-id <GROUP> --plan-group 'l'\\''UI simple' --title a`)));
  // La task merge finale consolide tout le lot : elle n'appartient à aucun groupe.
  assert.ok(!cmds.find((c) => c.includes('--type merge'))!.includes('--plan-group'));
});
