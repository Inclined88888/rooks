/**
 * Le module projets, monté pour de vrai — pas seulement décidé.
 *
 * "Fin du tier core" lui donne un id namespacé, et ce module se nomme
 * lui-même auprès de Cordis : `ctx.provide('@timon/projects')`. Un jeton de
 * service qui contient `@` et `/` n'est vérifié par aucun typage — `declare
 * module` accepte n'importe quelle clé, donc un `tsc` vert ne dit rien de ce
 * que Cordis en fait au boot. On applique donc le module sur un contexte réel
 * et on relit le jeton, sinon la seule façon de découvrir un refus serait un
 * daemon qui ne démarre pas.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

const { createHttpPlugin } = await import('../../kernel/http-service.js');
const { apply, name } = await import('./index.js');
const { CATALOG } = await import('../../kernel/catalog.js');

test('le module s\'applique sous son id namespacé et sert ses routes', async () => {
  const app = express();
  app.use(express.json());
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(name, '@timon/projects');
    apply(ctx);
    assert.ok(ctx['@timon/projects'], 'le jeton de service doit se résoudre sous son nom namespacé');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/projects`)).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await ctx.fiber.dispose();
  }
});

test('le module est du catalogue, hors noyau donc désactivable', () => {
  const entry = CATALOG.find((m) => m.id === '@timon/projects');
  assert.ok(entry, '@timon/projects doit figurer au catalogue');
  assert.equal(entry.tier, 'std');
  assert.equal(entry.name, './plugins-bundled/projects/index.js');
});
