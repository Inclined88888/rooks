/**
 * L'invariant qui empêche le prochain "dreams" : `inject` sans `dependsOn`.
 *
 * `inject` est une dépendance DURE en Cordis 4 et n'a pas de forme optionnelle.
 * Si le module qui fournit le service est éteint, le consommateur reste
 * PENDING **en silence** — et `auditActivation` fait alors sortir le daemon en
 * code 2. Un module éteint volontairement doit éteindre ceux qui en dépendent
 * (`dependsOn` + `cascadeDependencies`), jamais faire échouer le boot.
 *
 * Le piège est asymétrique : un service fourni par un module `core` ne s'éteint
 * jamais, donc l'injecter ne demande rien. C'est exactement pour ça qu'on ne le
 * voit pas venir — `db`, `settings` et `http` marchent, puis un module `std`
 * fournit un service à son tour et la règle change sans que personne la relise.
 *
 * Ce test lit la vérité des deux côtés : les `manifest.inject` sont importés
 * des modules eux-mêmes, les `ctx.provide` sont lus dans leur source.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { CATALOG } = await import('./catalog.js');
const { planEntries } = await import('./registry.js');
const { config } = await import('../config/load.js');
import type { ModuleDescriptor } from './registry.js';

/**
 * Services posés par `boot.ts` avant le loader : ils ne viennent d'aucune
 * entrée du catalogue et ne s'éteignent donc jamais.
 */
const ROOT_SERVICES = new Set(['http', 'host', 'timer', 'loader', 'logger']);

const hosted = CATALOG.filter((m) => !m.clientOnly);

/** `./plugins-bundled/x/index.js` (relatif à `dist/`) → chemin source. */
function sourcePath(m: ModuleDescriptor): string {
  const url = new URL(m.name.replace('./', '../').replace(/\.js$/, '.ts'), import.meta.url);
  return fileURLToPath(url);
}

const injects = new Map<string, readonly string[]>();
for (const m of hosted) {
  const mod = (await import(m.name.replace('./', '../'))) as { manifest?: { inject?: string[] } };
  assert.ok(mod.manifest, `${m.id} n'exporte pas de manifest`);
  injects.set(m.id, mod.manifest.inject ?? []);
}

/** Service → id du module qui le `provide`. */
const providers = new Map<string, string>();
for (const m of hosted) {
  const src = readFileSync(sourcePath(m), 'utf8');
  for (const match of src.matchAll(/ctx\.provide\('([^']+)'/g)) {
    providers.set(match[1], m.id);
  }
}

test('tout service injecté a un fournisseur connu', () => {
  for (const [id, list] of injects) {
    for (const service of list) {
      assert.ok(
        ROOT_SERVICES.has(service) || providers.has(service),
        `${id} injecte « ${service} » que personne ne fournit`,
      );
    }
  }
});

test('injecter un service désactivable impose un dependsOn sur son fournisseur', () => {
  const tierOf = new Map(CATALOG.map((m) => [m.id, m.tier]));
  for (const m of hosted) {
    for (const service of injects.get(m.id) ?? []) {
      if (ROOT_SERVICES.has(service)) continue;
      const provider = providers.get(service);
      if (provider === undefined || provider === m.id) continue;
      if (tierOf.get(provider) === 'core') continue; // un module core ne s'éteint pas
      assert.ok(
        (m.dependsOn ?? []).includes(provider),
        `${m.id} injecte « ${service} » (fourni par ${provider}, tier `
          + `${tierOf.get(provider)}) sans dependsOn : éteindre ${provider} le `
          + 'laisserait PENDING et ferait sortir le daemon en code 2',
      );
    }
  }
});

test('les dependsOn nomment des modules du catalogue', () => {
  const ids = new Set(CATALOG.map((m) => m.id));
  for (const m of CATALOG) {
    for (const dep of m.dependsOn ?? []) {
      assert.ok(ids.has(dep), `${m.id} dépend de ${dep}, absent du catalogue`);
    }
  }
});

/**
 * Le même invariant, mais joué : on éteint chaque module désactivable, un par
 * un, et on vérifie qu'AUCUNE entrée restée active n'injecte un service dont
 * le fournisseur vient de disparaître. C'est le test de boot demandé, sans
 * booter trente fois trente modules : ce que `planEntries` rend est exactement
 * ce que `boot.ts` donne au loader.
 */
test('éteindre un module désactivable ne laisse aucun fiber PENDING', () => {
  const base = config();
  for (const target of CATALOG) {
    if (target.tier === 'core' || target.clientOnly) continue;
    const cfg = { ...base, modules: { ...base.modules, [target.id]: false } };
    const decisions = planEntries(CATALOG, { config: cfg, capabilities: [] });
    const off = new Set(decisions.filter((d) => d.disabled).map((d) => d.id));
    assert.ok(off.has(target.id), `${target.id} devait s'éteindre`);
    for (const d of decisions) {
      if (d.disabled) continue;
      for (const service of injects.get(d.id) ?? []) {
        if (ROOT_SERVICES.has(service)) continue;
        const provider = providers.get(service);
        if (provider === undefined || provider === d.id) continue;
        assert.ok(
          !off.has(provider),
          `${target.id} éteint : ${d.id} reste actif alors que son fournisseur `
            + `${provider} (« ${service} ») est éteint — fiber PENDING, daemon en code 2`,
        );
      }
    }
  }
});

/**
 * TODO #275: the project's git routes lived in `kanban-code` (licensed,
 * dependent on the board), so switching Kanban off killed the Git cards.
 * They now belong to `@rooks/git`, which nothing about the board can switch off.
 */
test('@rooks/git survives the Kanban switched off; kanban-code follows git', () => {
  const base = config();
  const byId = (modules: Record<string, boolean>) => new Map(
    planEntries(CATALOG, { config: { ...base, modules: { ...base.modules, ...modules } }, capabilities: ['git'] })
      .map((d) => [d.id, d]),
  );

  const kanbanOff = byId({ '@rooks/kanban': false });
  assert.equal(kanbanOff.get('@rooks/git')?.disabled, false, 'git must not depend on the board');
  assert.equal(kanbanOff.get('@rooks/kanban-code')?.disabled, true);

  const gitOff = byId({ '@rooks/git': false });
  assert.equal(gitOff.get('@rooks/kanban-code')?.reason, 'depends on @rooks/git, which is disabled');
  assert.equal(gitOff.get('@rooks/kanban')?.disabled, false);
});

/**
 * TODO #356: the Files card reads `/api/agents/:name/files`, served by the
 * core agents module. Its dependency is declared, so the card can never be
 * on while the route it reads is off; switching it off touches nothing else.
 */
test('@rooks/files-widget depends on @rooks/agents and switches off alone', () => {
  const entry = CATALOG.find((m) => m.id === '@rooks/files-widget');
  assert.deepEqual(entry?.dependsOn, ['@rooks/agents']);
  assert.equal(entry?.clientOnly, true, 'the route stays in the core: no host half');
  const base = config();
  const byId = new Map(
    planEntries(CATALOG, { config: { ...base, modules: { ...base.modules, '@rooks/files-widget': false } }, capabilities: ['git'] })
      .map((d) => [d.id, d]),
  );
  assert.equal(byId.get('@rooks/files-widget')?.disabled, true);
  assert.equal(byId.get('@rooks/agents')?.disabled, false);
});

/**
 * TODO #357: the Skills and MCP cards read the skills and MCP routes of the
 * core agents module, like Files. Each switches off on its own.
 */
test('@rooks/skills-widget and @rooks/mcp-widget depend on @rooks/agents and switch off alone', () => {
  for (const id of ['@rooks/skills-widget', '@rooks/mcp-widget']) {
    const entry = CATALOG.find((m) => m.id === id);
    assert.deepEqual(entry?.dependsOn, ['@rooks/agents'], id);
    assert.equal(entry?.clientOnly, true, `${id}: the routes stay in the core, no host half`);
  }
  const base = config();
  const byId = new Map(
    planEntries(CATALOG, { config: { ...base, modules: { ...base.modules, '@rooks/skills-widget': false } }, capabilities: ['git'] })
      .map((d) => [d.id, d]),
  );
  assert.equal(byId.get('@rooks/skills-widget')?.disabled, true);
  assert.equal(byId.get('@rooks/mcp-widget')?.disabled, false, 'the MCP card does not follow the Skills card');
  assert.equal(byId.get('@rooks/files-widget')?.disabled, false);
  assert.equal(byId.get('@rooks/agents')?.disabled, false);
});
