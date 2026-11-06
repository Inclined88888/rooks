/**
 * L'audit d'activation — le seul garde-fou contre un module qui ne démarre pas
 * SANS RIEN DIRE.
 *
 * Le piège que ce test protège : en Cordis, un plugin dont un `inject` n'est
 * fourni par personne reste PENDING indéfiniment. Pas d'erreur, pas de log :
 * le module ne tourne simplement pas, et on s'en aperçoit des jours plus tard
 * parce qu'une task n'a jamais été dispatchée. Une dépendance mal orthographiée
 * ou un module désactivé par erreur produit exactement ça.
 */
// Isole TIMON_HOME AVANT tout module qui touche à l'état TIMON (cf. test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';

const { auditActivation, formatActivationFailures } = await import('./activation-audit.js');

/** Arbre minimal : un loader et rien d'autre à fournir. */
async function loaderContext(): Promise<Context> {
  const ctx = new Context();
  ctx.baseUrl = new URL('.', import.meta.url).href;
  await ctx.plugin(Loader);
  return ctx;
}

test("l'audit échoue en NOMMANT le service manquant d'un module resté PENDING", async () => {
  const ctx = await loaderContext();
  // `./fixtures/needs-dispatcher.js` déclare `inject: ['dispatcher']` et
  // personne ne fournit `dispatcher` — le cas exact du plan.
  await ctx.loader.create({ id: 'needs-dispatcher', name: './fixtures/needs-dispatcher.js' });

  const failures: unknown[] = [];
  await auditActivation(ctx, { timeoutMs: 1_000, onFailure: (f) => void failures.push(...f) });

  assert.equal(failures.length, 1, 'le module non activé doit être signalé');
  const rendered = formatActivationFailures(failures as never);
  assert.match(rendered, /needs-dispatcher/, "le rapport doit nommer l'entrée fautive");
  assert.match(rendered, /dispatcher/, 'et le service qui lui manque');
  await ctx.fiber.dispose();
});

test("un arbre dont tout est satisfait passe l'audit sans un mot", async () => {
  const ctx = await loaderContext();
  await ctx.loader.create({ id: 'provides-dispatcher', name: './fixtures/provides-dispatcher.js' });
  await ctx.loader.create({ id: 'needs-dispatcher', name: './fixtures/needs-dispatcher.js' });

  let called = false;
  const failures = await auditActivation(ctx, { timeoutMs: 1_000, onFailure: () => { called = true; } });
  assert.deepEqual(failures, []);
  assert.equal(called, false, 'aucun échec ne doit être signalé');
  await ctx.fiber.dispose();
});


test('provider readiness is armed before modules can start the dispatcher', () => {
  const source = readFileSync(new URL('../kernel-boot.ts', import.meta.url), 'utf8');
  const armed = source.indexOf('expectProviders();');
  assert.ok(armed >= 0);
  assert.ok(armed < source.indexOf('await ctx.plugin('), 'no module may activate before readiness is armed');
  assert.ok(source.indexOf('providersLoaded();') > source.indexOf('await loader.update();'),
    'the dispatcher is released after official providers are loaded');
});
