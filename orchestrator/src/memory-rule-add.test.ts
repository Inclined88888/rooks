/**
 * Tests de l'écriture directe d'une règle mémoire (memory-rule-add.ts).
 *
 * `import './test-home.js'` EN PREMIER : ce module touche la base via dbApi,
 * qui ouvre le fichier SQLite au chargement. Sans ça, la suite écrirait dans
 * `~/.timon/timon.db` — la vraie.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMemoryRule, MemoryRuleError } from './memory-rule-add.js';
import { dbApi } from './db.js';

/** Texte unique par test : la base de test est partagée par tout le fichier. */
let n = 0;
const uniq = () => `règle de test #${++n} — ${Math.random().toString(36).slice(2)}`;

test('insère une règle scope=agent et la rend listable', () => {
  const text = uniq();
  const rule = addMemoryRule({ scope: 'agent', agent: 'alice.main', text });
  assert.equal(rule.scope, 'agent');
  assert.equal(rule.agent, 'alice.main');
  assert.equal(rule.kind, 'pitfall');       // défaut
  assert.equal(rule.tier, 'normal');        // défaut
  assert.equal(rule.status, 'active');
  assert.equal(rule.source, 'manual');
  assert.equal(rule.text, text);
  const found = dbApi.listRules({ agent: 'alice.main' }).find((r) => r.id === rule.id);
  assert.ok(found, 'la règle doit apparaître dans listRules');
});

test('refuse un doublon exact sur le même scope', () => {
  const text = uniq();
  const first = addMemoryRule({ scope: 'agent', agent: 'dup.main', text });
  assert.throws(
    () => addMemoryRule({ scope: 'agent', agent: 'dup.main', text }),
    (err: unknown) => err instanceof MemoryRuleError && err.status === 409 && err.duplicate?.id === first.id,
  );
  assert.equal(dbApi.listRules({ agent: 'dup.main' }).length, 1);
});

test('le doublon est détecté malgré casse et espaces différents', () => {
  const text = uniq();
  addMemoryRule({ scope: 'agent', agent: 'norm.main', text });
  assert.throws(
    () => addMemoryRule({ scope: 'agent', agent: 'norm.main', text: `  ${text.toUpperCase()}  ` }),
    (err: unknown) => err instanceof MemoryRuleError && err.status === 409,
  );
});

test('le même texte sur un AUTRE scope passe', () => {
  const text = uniq();
  addMemoryRule({ scope: 'agent', agent: 'a.main', text });
  const other = addMemoryRule({ scope: 'agent', agent: 'b.main', text });
  assert.ok(other.id);
  const proj = addMemoryRule({ scope: 'project', project: 'timon', text });
  assert.equal(proj.scope, 'project');
});

test('un scope sans sa cible est refusé (règle orpheline, jamais injectée)', () => {
  for (const bad of [
    { scope: 'agent' },
    { scope: 'project' },
    { scope: 'role' },
  ]) {
    assert.throws(
      () => addMemoryRule({ ...bad, text: uniq() }),
      (err: unknown) => err instanceof MemoryRuleError && err.status === 400,
      `scope=${bad.scope} sans cible doit être refusé`,
    );
  }
});

test('scope=global n\'exige aucune cible', () => {
  const rule = addMemoryRule({ scope: 'global', kind: 'preference', text: uniq() });
  assert.equal(rule.scope, 'global');
  assert.equal(rule.agent, null);
  assert.equal(rule.project, null);
});

test('valeurs invalides refusées en 400', () => {
  assert.throws(() => addMemoryRule({ scope: 'nimportequoi', text: uniq() }),
    (e: unknown) => e instanceof MemoryRuleError && e.status === 400);
  assert.throws(() => addMemoryRule({ scope: 'global', kind: 'lubie', text: uniq() }),
    (e: unknown) => e instanceof MemoryRuleError && e.status === 400);
  assert.throws(() => addMemoryRule({ scope: 'global', tier: 'ultra', text: uniq() }),
    (e: unknown) => e instanceof MemoryRuleError && e.status === 400);
  assert.throws(() => addMemoryRule({ scope: 'global', text: '   ' }),
    (e: unknown) => e instanceof MemoryRuleError && e.status === 400);
});

test('tier=core est conservé (règle toujours injectée sur son scope)', () => {
  const rule = addMemoryRule({ scope: 'project', project: 'timon', tier: 'core', kind: 'decision', text: uniq() });
  assert.equal(rule.tier, 'core');
  assert.ok(dbApi.coreRulesForProject('timon').some((r) => r.id === rule.id));
});

test('une règle ajoutée est immédiatement visible au recall de son agent', () => {
  // Le point de la feature : ce que `timon memory rule add` écrit doit ressortir
  // du MÊME chemin que le spawn d'une mission emprunte (searchRules), sans
  // rebuild ni passage par une proposal.
  const text = 'les RDV pro sont sur le calendrier Google Working, jamais sur le primary Perso';
  const rule = addMemoryRule({ scope: 'agent', agent: 'recall.main', text });

  // Chemin FTS : la mission parle du sujet.
  const parFts = dbApi.searchRules('calendrier Google agenda', { agent: 'recall.main' });
  assert.ok(parFts.some((r) => r.id === rule.id), 'la règle doit sortir du recall FTS');

  // Chemin fallback récence : la mission ne mentionne rien de proche.
  const parRecence = dbApi.searchRules('', { agent: 'recall.main' });
  assert.ok(parRecence.some((r) => r.id === rule.id), 'la règle doit sortir du recall par récence');

  // Et elle reste cloisonnée à son agent.
  assert.equal(dbApi.searchRules('calendrier', { agent: 'autre.main' }).length, 0);
});
