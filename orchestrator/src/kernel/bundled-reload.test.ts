/**
 * La bascule à chaud d'un module bundled — ce que la galerie promet depuis
 * qu'elle liste le catalogue.
 *
 * Le trou que ces tests ferment : `POST /api/plugins/vault/enabled` écrivait
 * `modules.vault` et s'arrêtait là. L'arbre Cordis, monté une fois au boot,
 * gardait le module vivant et la carte affichait "au prochain démarrage" —
 * un redémarrage que personne ne déclenche, puisqu'il tuerait les missions en
 * vol. Les plugins tiers, eux, sont à chaud depuis P.3.
 *
 * L'arbre est composé ici comme `boot.ts` le compose, mais avec deux entrées :
 * booter le catalogue entier dans une suite de tests monterait trente modules,
 * leurs timers et leurs boucles pour observer une route qui s'éteint.
 */
// Isole ROOKS_HOME AVANT tout module qui touche à l'état ROOKS (cf. test-home.ts).
import '../test-home.js';
import { paidTestLicense } from '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Timer from '@deepseek-ai/cordis-plugin-timer';

const { createHttpPlugin } = await import('./http-service.js');
const { planEntries, toLoaderEntries } = await import('./registry.js');
const { createBundledReconciler, attachBundledReconciler } = await import('./bundled-reload.js');
const { capabilitiesPayload, setLiveDecisions } = await import('./capabilities.js');
const { setModuleEnabled } = await import('./module-config.js');
const { registerRoutes } = await import('../plugins-bundled/plugins/routes.js');
const { CONFIG_FILE, resetConfig } = await import('../config/load.js');
const { setLicenseState } = await import('../license/runtime.js');
import type { ModuleDescriptor } from './registry.js';
import type { PluginPublic } from '../plugins/public.js';

/** Le noyau minimal, une cobaye libre, et une cobaye vendue (licence lic-6). */
const CATALOG: readonly ModuleDescriptor[] = [
  { id: '@rooks/db', name: './plugins-bundled/db/index.js', tier: 'core' },
  { id: '@rooks/vault', name: './plugins-bundled/vault/index.js', tier: 'opt' },
  { id: '@rooks/dreams', name: './plugins-bundled/gpt-live/index.js', tier: 'opt', inject: ['http'], licensed: true },
];

type Kernel = {
  url: (path: string) => string;
  reconcile: () => Promise<string[]>;
  changes: string[][];
  close: () => Promise<void>;
};

const RESTRICTED_PAID = { ...paidTestLicense(), modules: [], plugins: [] };

async function kernel(): Promise<Kernel> {
  writeFileSync(CONFIG_FILE, '{}\n');
  resetConfig();
  // `licenseState()` is a module-wide singleton (kernel/bundled-reload.ts now
  // reads it live) — reset it so a test that installs a licence never leaks
  // into the next one sharing this process.
  setLicenseState(RESTRICTED_PAID);

  const app = express();
  app.use(express.json());
  const ctx = new Context();
  // Les noms d'entrée sont relatifs à `src/`, comme ils le sont à `dist/`
  // depuis `boot.js`. Sous `tsx`, `./x/index.js` résout `index.ts`.
  ctx.baseUrl = new URL('../', import.meta.url).href;
  await ctx.plugin(Timer);
  await ctx.plugin(createHttpPlugin(app));
  await ctx.plugin(Loader);

  const decisions = planEntries(CATALOG, { config: (await import('../config/load.js')).config(), capabilities: [], licensed: [] });
  setLiveDecisions(decisions, [], 'expert');
  for (const entry of toLoaderEntries(decisions)) await ctx.loader.create(entry);

  registerRoutes(ctx.http.router());

  const changes: string[][] = [];
  const reconciler = createBundledReconciler(ctx, {
    catalog: CATALOG,
    capabilities: [],
    decisions,
    onChange: (ids) => void changes.push(ids),
  });
  attachBundledReconciler(app, reconciler);
  const stopWatch = reconciler.watch(50);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    reconcile: () => reconciler.reconcile(),
    changes,
    close: async () => {
      stopWatch();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
      await ctx.fiber.dispose();
    },
  };
}

/** Le serveur et l'arbre partent quoi qu'il arrive : un handle ouvert fige `node --test`. */
async function withKernel(body: (k: Kernel) => Promise<void>): Promise<void> {
  const k = await kernel();
  try { await body(k); } finally { await k.close(); }
}

function toggle(k: Kernel, id: string, enabled: boolean): Promise<Response> {
  // L'id porte un `/` : sans encodage, Express y voit deux segments et la
  // route rend 404 au lieu de basculer le module.
  return fetch(k.url(`/api/plugins/${encodeURIComponent(id)}/enabled`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

function moduleActive(id: string): boolean | undefined {
  return capabilitiesPayload().modules.find((m) => m.id === id)?.active;
}

/** 400 = la route répond (paramètre invalide), 404 = le module est parti. */
function vaultProbe(k: Kernel): Promise<Response> {
  return fetch(k.url('/api/vault/note'));
}

test('éteindre un module bundled retire ses routes SANS redémarrer le daemon', async () => {
  await withKernel(async (k) => {
    assert.equal((await vaultProbe(k)).status, 400, 'vault répond avant la bascule');

    const off = await toggle(k, '@rooks/vault', false);
    assert.equal(off.status, 200);

    // Même process, aucune relecture de boot : l'arbre a été recomposé pendant
    // la requête, donc la relecture qui suit dit déjà la vérité.
    assert.equal(moduleActive('@rooks/vault'), false, '/api/capabilities suit l\'arbre');
    assert.equal((await vaultProbe(k)).status, 404, 'la coquille du routeur est devenue inerte');

    const { plugins } = await (await fetch(k.url('/api/plugins'))).json() as { plugins: PluginPublic[] };
    const vault = plugins.find((p) => p.id === '@rooks/vault');
    assert.equal(vault?.state, 'disabled');
    assert.equal(vault?.wanted, false, 'la config et l\'arbre disent la même chose');

    const on = await toggle(k, '@rooks/vault', true);
    assert.equal(on.status, 200);
    assert.equal(moduleActive('@rooks/vault'), true);
    assert.equal((await vaultProbe(k)).status, 400, 'rallumer remonte les routes');
  });
});

test('un module core reste irrévocable, et rien n\'est recomposé', async () => {
  await withKernel(async (k) => {
    const refused = await toggle(k, '@rooks/db', false);
    assert.equal(refused.status, 403);
    assert.equal(moduleActive('@rooks/db'), true);
    assert.deepEqual(k.changes, [], 'un refus ne publie pas de recomposition');
    const written = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { modules?: Record<string, unknown> };
    assert.equal(written.modules?.['@rooks/db'], undefined);
  });
});

test('une écriture qui ne touche pas `modules` ne recompose rien', async () => {
  await withKernel(async (k) => {
    // Le compteur d'events du bus ne prouverait rien : le loader de plugins
    // tiers surveille le MÊME fichier et publie sur la même écriture. On
    // interroge donc le réconciliateur lui-même.
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
    cfg.ui = { hidden: ['nav.brain'], home: 'chat' };
    writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);

    assert.deepEqual(await k.reconcile(), [], 'aucun module n\'a changé de camp');
    assert.deepEqual(k.changes, []);
    assert.equal((await vaultProbe(k)).status, 400);
  });
});

test('une configuration illisible laisse le dernier arbre valide en place', async () => {
  await withKernel(async (k) => {
    writeFileSync(CONFIG_FILE, '{ "modules": { "@rooks/vault": ');

    assert.deepEqual(await k.reconcile(), [], 'un fichier à moitié écrit ne démonte rien');
    assert.equal((await vaultProbe(k)).status, 400, 'vault tourne toujours');
    assert.equal(moduleActive('@rooks/vault'), true);
  });
});

test('`rooks module disable` est à chaud aussi : le watcher suffit, sans requête', async () => {
  await withKernel(async (k) => {
    // Exactement ce que fait la CLI : écrire la config, et rien d'autre.
    // `watchFile` takes its baseline stat asynchronously, on the libuv
    // threadpool: under load, a single write can land BEFORE that baseline,
    // which then already holds the new config — no change is ever seen. A
    // real CLI write always comes later, so we keep rewriting until the
    // watcher reacts; it is still the watcher alone that recomposes (no
    // request is made).
    const deadline = Date.now() + 10_000;
    let rewriteAt = 0;
    while (Date.now() < deadline && (await vaultProbe(k)).status !== 404) {
      if (Date.now() >= rewriteAt) {
        setModuleEnabled('@rooks/vault', false);
        rewriteAt = Date.now() + 1_000;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal((await vaultProbe(k)).status, 404, 'le watcher de config recompose sans passer par HTTP');
    assert.deepEqual(k.changes.at(-1), ['@rooks/vault']);
  });
});

test('installer une licence qui couvre un module vendu le rallume sans redémarrer (lic-6)', async () => {
  await withKernel(async (k) => {
    assert.equal(moduleActive('@rooks/dreams'), false, 'non couvert au boot : aucune licence installée');

    setLicenseState({
      status: 'valid', reason: null, edition: 'expert',
      modules: ['@rooks/dreams'], plugins: [],
      expiresAt: null, subscriptionExpiresAt: null, paymentStatus: 'active',
    });
    assert.deepEqual(await k.reconcile(), ['@rooks/dreams'], 'le reconciler relit licenseState(), pas une valeur figée au boot');
    assert.equal(moduleActive('@rooks/dreams'), true, 'la licence installée rallume le module sans passer par un restart');

    setLicenseState(RESTRICTED_PAID);
    assert.deepEqual(await k.reconcile(), ['@rooks/dreams'], 'a licence that no longer covers it removes the module just as fast');
    assert.equal(moduleActive('@rooks/dreams'), false);

    // An expired licence falls back to Free, which grants every module.
    setLicenseState((await import('../license/license.js')).unlicensed('expired'));
    assert.deepEqual(await k.reconcile(), ['@rooks/dreams']);
    assert.equal(moduleActive('@rooks/dreams'), true);
  });
});

// A queued reload must not mutate global decisions after its owner is gone.
test('disposing a reconciler cancels queued changes before loader effects', async () => {
  writeFileSync(CONFIG_FILE, '{}\n');
  resetConfig();
  setLicenseState(RESTRICTED_PAID);
  let updates = 0;
  const ctx = { loader: { update: async () => { updates++; } } } as unknown as Context;
  const decisions = planEntries(CATALOG, { config: (await import('../config/load.js')).config(), capabilities: [], licensed: [] });
  const reconciler = createBundledReconciler(ctx, { catalog: CATALOG, capabilities: [], decisions });
  setModuleEnabled('@rooks/vault', false);
  const queued = reconciler.reconcile();
  reconciler.dispose();
  assert.deepEqual(await queued, []);
  assert.deepEqual(await reconciler.reconcile(), []);
  assert.equal(updates, 0);
});
