/**
 * The daemon without a vault — what an install that never wanted one gets.
 *
 * The vault became a `tier: opt` module: switching it off must take away its
 * routes AND stop every path that lives outside it from reading the vault
 * anyway. Two of those paths are the ones that matter, because they run on
 * every launch: the environment handed to a mission (`missionEnv`, the spawn
 * path) and the inject journal.
 *
 * The assertion that discriminates is not "nothing throws" — nothing threw
 * before this gate existed either. It is that a secret which IS granted, and
 * which the very same code injects when the module runs, does NOT reach the
 * mission environment when it does not. The two halves are asserted back to
 * back so a gate that silently stops working cannot pass by disabling both.
 *
 * The kernel is composed as `boot.ts` composes it, with two entries: booting
 * the whole catalogue to watch one route disappear would mount thirty modules
 * and their timers (same reasoning as `kernel/bundled-reload.test.ts`).
 */
// Isole ROOKS_HOME AVANT tout module qui touche à l'état ROOKS (cf. test-home.ts).
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Timer from '@deepseek-ai/cordis-plugin-timer';
import type { ModuleDescriptor } from '../kernel/registry.js';

const { createHttpPlugin } = await import('../kernel/http-service.js');
const { planEntries, toLoaderEntries } = await import('../kernel/registry.js');
const { setLiveDecisions } = await import('../kernel/capabilities.js');
const { CONFIG_FILE, config, resetConfig } = await import('../config/load.js');
const { dbApi } = await import('../db.js');
const { missionEnv } = await import('../agent.js');
const { injectedSecretsFor, journalInjectedSecrets } = await import('./env.js');
const { SECRETS_MODULE_ID } = await import('./availability.js');

/** Le noyau minimal, et la cobaye. */
const CATALOG: readonly ModuleDescriptor[] = [
  { id: 'core-db', name: './plugins-bundled/db/index.js', tier: 'core' },
  { id: SECRETS_MODULE_ID, name: './plugins-bundled/secrets-vault/index.js', tier: 'opt' },
];

const NAME = 'VAULT_OFF_WITNESS';
const VALUE = 'value-that-must-not-reach-a-mission';

const secret = dbApi.createSecret({
  // Pas scellé : une ligne héritée en clair (§10) suit exactement le même
  // chemin d'injection, sans exiger de clé maîtresse dans ce test.
  name: NAME, value_enc: VALUE, mode: 'inject',
});
dbApi.addSecretGrant(secret.id, 'global');

/** Monte l'arbre avec le coffre voulu ou non, et rend l'URL du témoin HTTP. */
async function kernel(vaultWanted: boolean): Promise<{ base: string; close: () => Promise<void> }> {
  writeFileSync(CONFIG_FILE, `${JSON.stringify({ modules: { [SECRETS_MODULE_ID]: vaultWanted } })}\n`);
  resetConfig();

  const app = express();
  app.use(express.json());
  const ctx = new Context();
  // Les noms d'entrée sont relatifs à `src/`, comme ils le sont à `dist/`
  // depuis `boot.js`. Sous `tsx`, `./x/index.js` résout `index.ts`.
  ctx.baseUrl = new URL('../', import.meta.url).href;
  await ctx.plugin(Timer);
  await ctx.plugin(createHttpPlugin(app));
  await ctx.plugin(Loader);

  const decisions = planEntries(CATALOG, { config: config(), capabilities: [] });
  setLiveDecisions(decisions, [], 'expert');
  for (const entry of toLoaderEntries(decisions)) await ctx.loader.create(entry);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  assert.notEqual(port, 3000, 'le témoin ne prend jamais le port de production');
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => { server.close(); await ctx.fiber.dispose(); },
  };
}

test('coffre éteint : pas de route, pas de secret dans l’environnement d’une mission', async () => {
  const k = await kernel(false);
  try {
    assert.equal((await fetch(`${k.base}/api/secrets`)).status, 404, 'aucune route secrets sans le module');

    // Le chemin de lancement, sans base de secrets lue et sans exception.
    const env = missionEnv({ missionId: 'm-vault-off', agentName: 'witness', project: 'p' });
    assert.equal(env[NAME], undefined, 'un secret accordé ne doit pas entrer dans une mission sans coffre');
    assert.ok(env.PATH !== undefined, 'la liste blanche système reste, elle');

    const slice = injectedSecretsFor({ agent: 'witness', project: 'p' });
    assert.deepEqual(slice, { env: {}, injected: [] });
    // Rien à journaliser, et surtout aucune écriture : le journal d'accès est
    // une route du module, qui n'existe plus.
    journalInjectedSecrets({ missionId: 'm-vault-off', agent: 'witness', injected: slice.injected });
    assert.equal(dbApi.listSecretAccess(secret.id).length, 0);
  } finally {
    await k.close();
  }
});

test('coffre allumé : le même secret, la même mission, et il est bien injecté', async () => {
  const k = await kernel(true);
  try {
    assert.notEqual((await fetch(`${k.base}/api/secrets`)).status, 404, 'le module rallumé reprend ses routes');
    const env = missionEnv({ missionId: 'm-vault-on', agentName: 'witness', project: 'p' });
    assert.equal(env[NAME], VALUE, 'sans cette moitié, le test précédent ne prouverait rien');
  } finally {
    await k.close();
  }
});
