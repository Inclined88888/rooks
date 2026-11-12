/**
 * Le noyau — quatre fichiers de glue au-dessus de Cordis.
 *
 * Ce que ces tests protègent : le pont d'événements (les modules doivent voir
 * le bus historique et se désinscrire tout seuls), la réversibilité des routes
 * (un module déchargé ne doit plus répondre), le filtrage par capacités hôte,
 * et surtout l'audit d'activation — sans lui, un `inject` non satisfait laisse
 * un module muet et personne ne s'en aperçoit.
 */
// Isole ROOKS_HOME AVANT tout module qui touche à l'état ROOKS (cf. test-home.ts).
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

const { bus } = await import('../bus.js');
const { apply: applyBusBridge } = await import('./bus-bridge.js');
const { installRejectionGuard } = await import('./rejection-guard.js');
const { createHttpPlugin } = await import('./http-service.js');
const { planEntries, toLoaderEntries, capabilitiesReport } = await import('./registry.js');
const { collectActivationFailures, formatActivationFailures } = await import('./activation-audit.js');
const { loadConfig } = await import('../config/load.js');
const { CATALOG } = await import('./catalog.js');

/** Config par défaut : aucun fichier, donc l'installation actuelle. */
const baseConfig = () => loadConfig('/nulle/part/rooks.config.json');

test('the real browser module is available on macOS without Docker or Traefik', async () => {
  const descriptor = CATALOG.find((entry) => entry.id === '@rooks/browser-embedded')!;
  const { manifest } = await import('../plugins-bundled/browser-embedded/index.js');
  assert.deepEqual(descriptor.requires, manifest.requires);
  const [decision] = planEntries([descriptor], { config: baseConfig(), capabilities: ['gui'] });
  assert.equal(decision?.disabled, false);
  assert.deepEqual(decision?.missing, []);
  const [unlicensed] = planEntries([descriptor], { config: baseConfig(), capabilities: ['gui'], licensed: [] });
  assert.equal(unlicensed?.disabled, false, 'the browser is included without a paid licence');
});

test('le pont republie les events du bus sur le contexte, et se retire avec son fiber', async () => {
  const root = new Context();
  const seen: string[] = [];
  const fiber = await root.plugin({ name: 'bridge', apply: applyBusBridge });
  root.on('rooks/mission_complete', (ev) => void seen.push(ev.missionId));

  bus.publish({ kind: 'mission_complete', missionId: 'm1', status: 'completed', exitCode: 0 });
  assert.deepEqual(seen, ['m1']);

  // Décharger le pont doit couper la republication : sinon chaque rechargement
  // à chaud empilerait un listener de plus sur un bus qui n'en perd jamais.
  await fiber.dispose();
  bus.publish({ kind: 'mission_complete', missionId: 'm2', status: 'completed', exitCode: 0 });
  assert.deepEqual(seen, ['m1'], 'le pont déchargé ne doit plus republier');
  await root.fiber.dispose();
});

test('a bundled module whose raw listener throws or rejects fails alone: the publisher and the other listeners carry on (#630)', async () => {
  const logs: string[] = [];
  const uninstall = installRejectionGuard({ log: (line) => void logs.push(line), notify: () => assert.fail('a module is not a plugin: no notification') });
  const root = new Context();
  const seen: string[] = [];
  try {
    await root.plugin({ name: 'bridge', apply: applyBusBridge });
    await root.plugin({
      name: '@rooks/faulty',
      apply(ctx: Context) {
        ctx.on('rooks/mission_complete', () => { throw new Error('faulty listener'); });
        ctx.on('rooks/mission_complete', async () => { throw new Error('faulty async listener'); });
      },
    });
    root.on('rooks/mission_complete', (ev) => void seen.push(`cordis:${ev.missionId}`));
    // A plain bus subscriber registered after the bridge: the emitter's own
    // loop must reach it too.
    const later = (ev: { kind: string }) => { if (ev.kind === 'mission_complete') seen.push('bus'); };
    bus.on('event', later);
    try {
      assert.doesNotThrow(() => bus.publish({ kind: 'mission_complete', missionId: 'm1', status: 'completed', exitCode: 0 }),
        'the publishing write must not inherit the module\'s throw');
    } finally {
      bus.off('event', later);
    }
    assert.deepEqual(seen, ['cordis:m1', 'bus'], 'the listeners after the faulty one still receive the event');

    await new Promise((r) => setImmediate(r));
    const sync = logs.find((l) => l.includes('faulty listener'));
    const rejected = logs.find((l) => l.includes('faulty async listener'));
    assert.ok(sync?.includes('module `@rooks/faulty` in event rooks/mission_complete'), `throw put on the module: ${sync}`);
    assert.ok(rejected?.includes('module `@rooks/faulty` in event rooks/mission_complete'), `rejection put on the module: ${rejected}`);
  } finally {
    uninstall();
    await root.fiber.dispose();
  }
});

test('the isolated bridge keeps Cordis semantics: order, the dispatch notice, and a listener that unsubscribes mid-event', async () => {
  const root = new Context();
  const order: string[] = [];
  try {
    await root.plugin({ name: 'bridge', apply: applyBusBridge });
    root.on('internal/dispatch', (mode, name) => { if (name === 'rooks/mission_complete') order.push(`notice:${mode}`); });
    root.once('rooks/mission_complete', () => void order.push('once'));
    root.on('rooks/mission_complete', () => void order.push('second'));
    root.on('rooks/mission_complete', () => void order.push('first'), true);

    bus.publish({ kind: 'mission_complete', missionId: 'm1', status: 'completed', exitCode: 0 });
    bus.publish({ kind: 'mission_complete', missionId: 'm2', status: 'completed', exitCode: 0 });
    assert.deepEqual(order, ['notice:emit', 'first', 'once', 'second', 'notice:emit', 'first', 'second']);
  } finally {
    await root.fiber.dispose();
  }
});

test('une route posée par un module disparaît quand le module est déchargé', async () => {
  const app = express();
  const root = new Context();
  await root.plugin(createHttpPlugin(app));

  const mod = await root.plugin({
    name: 'demo',
    inject: ['http'],
    apply(ctx: Context) {
      ctx.http.router('/api/demo').get('/ping', (_req, res) => void res.json({ ok: true }));
    },
  });

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/demo/ping`;

  assert.equal((await fetch(url)).status, 200);
  await mod.dispose();
  assert.equal((await fetch(url)).status, 404, 'la route doit tomber avec son module');

  server.close();
  await root.fiber.dispose();
});

test('le registre désactive ce que la machine ne peut pas faire, et jamais le noyau', () => {
  const cfg = baseConfig();
  cfg.modules['@rooks/video-factory'] = false;
  cfg.modules['@rooks/browser-embedded'] = { enabled: true, port: 4444 };

  const decisions = planEntries(
    [
      { id: '@rooks/db', name: './plugins-bundled/db/index.js', tier: 'core' },
      { id: '@rooks/grepai', name: './plugins-bundled/grepai/index.js', tier: 'dev', requires: ['grepai', 'systemd'] },
      { id: '@rooks/docker-supervision', name: './plugins-bundled/docker-supervision/index.js', tier: 'dev', requires: ['containers'] },
      { id: '@rooks/video-factory', name: './plugins-bundled/video-factory/index.js', tier: 'opt' },
      { id: '@rooks/browser-embedded', name: './plugins-bundled/browser-embedded/index.js', tier: 'opt', requires: ['containers', 'traefik'] },
    ],
    { config: cfg, capabilities: ['systemd', 'grepai'] },
  );
  const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));

  assert.equal(byId['@rooks/db'].disabled, false);
  assert.equal(byId['@rooks/grepai'].disabled, false, 'toutes ses capacités sont là');
  assert.match(byId['@rooks/docker-supervision'].reason ?? '', /containers/);
  assert.equal(byId['@rooks/video-factory'].reason, 'disabled in rooks.config.json');
  // Forcé à `true` : il tourne malgré les capacités absentes, mais le manque
  // reste visible — c'est un choix de l'utilisateur, pas un oubli du système.
  assert.equal(byId['@rooks/browser-embedded'].disabled, false);
  assert.deepEqual(byId['@rooks/browser-embedded'].missing, ['containers', 'traefik']);
  assert.deepEqual(byId['@rooks/browser-embedded'].config, { port: 4444 });

  const entries = toLoaderEntries(decisions);
  assert.deepEqual(entries.find((e) => e.id === '@rooks/docker-supervision'), {
    id: '@rooks/docker-supervision',
    name: './plugins-bundled/docker-supervision/index.js',
    disabled: true,
  });

  const report = capabilitiesReport(decisions, { config: cfg, capabilities: ['systemd', 'grepai'] });
  assert.equal(report.edition, 'expert');
  assert.equal(report.modules.find((m) => m.id === '@rooks/docker-supervision')?.active, false);
});

test('les options d\'un module remontent dans le rapport de capacités', () => {
  // Ce qu'elles portent : une option qui décide d'une SURFACE n'est lisible ni
  // dans le tier ni dans `ui.hidden`. Sans ce passe-plat, le front devrait une
  // route par module pour lire une clé que la config a déjà.
  const cfg = baseConfig();
  cfg.modules['@rooks/vault'] = { enabled: true, surfaces: ['widget'] };
  const decisions = planEntries(
    [{ id: '@rooks/vault', name: './x.js', tier: 'std' }],
    { config: cfg, capabilities: [] },
  );
  const report = capabilitiesReport(decisions, { config: cfg, capabilities: [] });
  // `enabled` reste au noyau : il décide du montage, pas de la surface.
  assert.deepEqual(report.modules[0]?.options, { surfaces: ['widget'] });

  const nu = capabilitiesReport(
    planEntries([{ id: 'kanban', name: './x.js', tier: 'std' }], { config: cfg, capabilities: [] }),
    { config: cfg, capabilities: [] },
  );
  assert.deepEqual(nu.modules[0]?.options, {}, 'un module sans options en rend un objet vide');
});

test('une licence restrictive l\'emporte sur un module vendu forcé dans la config', () => {
  const cfg = baseConfig();
  cfg.modules['@rooks/dreams'] = true;
  const [decision] = planEntries(
    [{ id: '@rooks/dreams', name: './x.js', tier: 'std', licensed: true }],
    { config: cfg, capabilities: [], licensed: ['@rooks/kanban-code'] },
  );
  assert.equal(decision.reason, 'not included in this licence');
});

test('la licence ne touche pas les modules libres', () => {
  // §10.7 : seuls les modules marqués `licensed` sont vendus. Si la liste
  // blanche gouvernait tout le catalogue, une licence Lite — ou l'absence de
  // licence — éteindrait le produit au lieu de le brider.
  const cfg = baseConfig();
  const [decision] = planEntries(
    [{ id: '@rooks/grepai', name: './x.js', tier: 'dev' }],
    { config: cfg, capabilities: ['grepai', 'systemd'], licensed: ['@rooks/kanban-code'] },
  );
  assert.equal(decision.reason, null);
  assert.equal(decision.disabled, false);
});

test('les modules vendus du §10.7 sont marqués dans le catalogue', () => {
  // Le marquage vit dans deux fichiers (le manifeste du module et le
  // catalogue) ; ce test est ce qui les empêche de diverger en silence.
  const vendus = CATALOG.filter((m) => m.licensed).map((m) => m.id).sort();
  assert.deepEqual(vendus, ['@rooks/dreams', '@rooks/kanban-code', '@rooks/machines']);
});

/**
 * Les deux tables du renommage (§10.14) : le catalogue dit ce qui existe, les
 * alias disent comment on appelait un module avant. Un alias qui ne désigne
 * plus rien traduirait une config valide en clé morte, sans un mot.
 */
test('tout module du catalogue porte le scope @rooks, et les alias y pointent', async () => {
  const { LEGACY_IDS } = await import('./legacy-ids.js');
  const ids = new Set(CATALOG.map((m) => m.id));

  for (const id of ids) assert.match(id, /^@rooks\//, `${id} doit porter le scope @rooks`);
  assert.equal(ids.size, CATALOG.length, 'un id ne paraît qu\'une fois');

  for (const [legacy, current] of Object.entries(LEGACY_IDS)) {
    assert.ok(ids.has(current), `l'alias ${legacy} pointe sur ${current}, absent du catalogue`);
    assert.equal(ids.has(legacy), false, `${legacy} est un ancien id, il ne doit plus être au catalogue`);
  }
});

/**
 * What becomes of a removed module. `@rooks/backlog` is no longer in the
 * catalogue and has no alias: the notebook merged into `@rooks/kanban`, which
 * an alias translation would switch off by mistake.
 */
test('un id retiré ne s\'alias vers rien et ne casse pas une config existante', async () => {
  const { LEGACY_IDS, RETIRED_IDS, canonicalModuleId, isRetiredModuleId } =
    await import('./legacy-ids.js');
  const ids = new Set(CATALOG.map((m) => m.id));

  for (const retire of RETIRED_IDS) {
    assert.equal(ids.has(retire), false, `${retire} est retiré, il ne doit plus être au catalogue`);
    assert.equal(LEGACY_IDS[retire], undefined, `${retire} ne doit pas être aliasé vers un successeur`);
    assert.equal(canonicalModuleId(retire), retire, 'un id retiré est rendu tel quel');
    assert.equal(isRetiredModuleId(retire), true);
  }
  assert.equal(isRetiredModuleId('@rooks/dreams'), false, 'un module vivant n\'est pas retiré');

  // Une `rooks.config.json` écrite avant le retrait continue de charger : la
  // clé ne désigne plus rien, et le plan se contente de l'ignorer.
  const cfg = baseConfig();
  cfg.modules['@rooks/backlog'] = false;
  const decisions = planEntries([{ id: '@rooks/kanban', name: './kanban.js', tier: 'std' }], {
    config: cfg,
    capabilities: [],
  });
  assert.deepEqual(decisions.map((d) => d.id), ['@rooks/kanban']);
  assert.equal(decisions[0]?.disabled, false);
});

// The Google agenda left the product on 06/11/2026 (tag `agenda-before-removal`).
// An installation that had it switched on carries `"@rooks/agenda": true` in its
// `rooks.config.json`: loading that file must neither throw nor change what the
// real catalogue mounts.
test('a config that still turns the removed agenda modules on loads, and the plan ignores them', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { isRetiredModuleId } = await import('./legacy-ids.js');
  const file = join(mkdtempSync(join(tmpdir(), 'rooks-retired-agenda-')), 'rooks.config.json');
  writeFileSync(file, JSON.stringify({
    modules: {
      agenda: true,
      'google-calendar': true,
      '@rooks/agenda': true,
      '@rooks/google-calendar': { enabled: true, account: 'work' },
    },
  }));
  const cfg = loadConfig(file, { readonly: true });
  for (const id of ['agenda', 'google-calendar', '@rooks/agenda', '@rooks/google-calendar']) {
    assert.equal(isRetiredModuleId(id), true, `${id} is a retired id`);
    assert.equal(CATALOG.some((m) => m.id === id), false, `${id} left the catalogue`);
  }
  const plan = (config: typeof cfg) => planEntries(CATALOG, { config, capabilities: [] })
    .map((d) => `${d.id}:${d.disabled ? 'off' : 'on'}`);
  assert.deepEqual(plan(cfg), plan(baseConfig()), 'the retired keys switch nothing on or off');
});

test('l\'audit nomme le service manquant d\'un module resté PENDING', async () => {
  const root = new Context();
  // Reproduit le piège en dur, sans loader : un `inject` que personne ne fournit.
  const fiber = await root.plugin({ name: 'orphelin', inject: ['dispatcher'], apply() { /* jamais appelé */ } });
  assert.notEqual(fiber.state, 2 /* ACTIVE */, 'un inject non satisfait ne doit pas activer le module');

  // Sans loader monté, l'audit n'a rien à inspecter : c'est le cas du legacy,
  // qui doit rester silencieux plutôt que d'échouer.
  assert.deepEqual(await collectActivationFailures(root), []);

  const rendered = formatActivationFailures([
    { entry: '@rooks/missions', state: 'pending', detail: 'missing services: dispatcher' },
  ]);
  assert.match(rendered, /@rooks\/missions/);
  assert.match(rendered, /dispatcher/);
  await root.fiber.dispose();
});

test('un module éteint éteint ceux qui en dépendent, en cascade', () => {
  // Le cas réel : `@rooks/dreams` injecte le service `memory`. Sans cascade,
  // éteindre `@rooks/memory` laisse le fiber de `@rooks/dreams` PENDING, et
  // `auditActivation` sort en code 2 — le daemon refuse de démarrer pour un module OPTIONNEL éteint
  // volontairement. La cascade transforme ce crash en décision lisible.
  const cfg = baseConfig();
  cfg.modules['@rooks/memory'] = false;

  const decisions = planEntries(
    [
      { id: '@rooks/db', name: './core-db.js', tier: 'core', dependsOn: ['@rooks/memory'] },
      { id: '@rooks/memory', name: './memory.js', tier: 'opt' },
      { id: '@rooks/dreams', name: './dreams.js', tier: 'std', dependsOn: ['@rooks/memory'] },
      { id: 'aval', name: './aval.js', tier: 'opt', dependsOn: ['@rooks/dreams'] },
      { id: '@rooks/kanban', name: './kanban.js', tier: 'std' },
    ],
    { config: cfg, capabilities: [] },
  );
  const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));

  assert.equal(byId['@rooks/memory'].reason, 'disabled in rooks.config.json');
  assert.equal(byId['@rooks/dreams'].reason, 'depends on @rooks/memory, which is disabled');
  // Point fixe : la chaîne s'éteint entièrement, quel que soit l'ordre du
  // catalogue (`aval` est listé après `dreams`, mais aussi après `memory`).
  assert.equal(byId['aval'].reason, 'depends on @rooks/dreams, which is disabled');
  assert.equal(byId['@rooks/kanban'].disabled, false, 'un module sans lien ne bouge pas');
  // Le noyau ne cascade jamais : une dépendance fausse dans le catalogue ne
  // doit pas pouvoir éteindre la base.
  assert.equal(byId['@rooks/db'].disabled, false);
});
