/**
 * Le partage `dreams` / carnet "TO DO" — qui sert quoi.
 *
 * Le risque de cette extraction n'est pas le code déplacé (verbatim), c'est
 * une route qui resterait des deux côtés (double montage) ou d'aucun (route
 * perdue). On monte donc chaque routeur SEUL et on vérifie qu'il sert
 * exactement sa moitié : `dreams` les rêves et le scoring de projets,
 * `@timon/kanban` le carnet "TO DO".
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Router } from 'express';

const dreamRoutes = await import('./routes.js');
const backlogRoutes = await import('../kanban/project-todo-routes.js');
const { CATALOG } = await import('../../kernel/catalog.js');

/** Un serveur éphémère par routeur : aucun état partagé entre les deux. */
async function serve(register: (r: Router) => void): Promise<{ url: (p: string) => string; close: () => void }> {
  const app = express();
  app.use(express.json());
  register(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { url: (p) => `http://127.0.0.1:${port}${p}`, close: () => server.close() };
}

test('le module dreams sert les rêves et le scoring de projets', async () => {
  const d = await serve(dreamRoutes.registerRoutes);
  try {
    assert.equal((await fetch(d.url('/api/dreams/config'))).status, 200);
    assert.equal((await fetch(d.url('/api/dreams'))).status, 200);
    assert.equal((await fetch(d.url('/api/projects/scores'))).status, 200);
    // Le carnet "plus tard" n'est pas à lui.
    assert.equal((await fetch(d.url('/api/project-todo'))).status, 404);
  } finally { d.close(); }
});

test('le carnet « TO DO » est servi par @timon/kanban, pas par dreams', async () => {
  const d = await serve(backlogRoutes.registerRoutes);
  try {
    assert.equal((await fetch(d.url('/api/project-todo'))).status, 200);
    assert.equal((await fetch(d.url('/api/dreams'))).status, 404);
    assert.equal((await fetch(d.url('/api/dreams/config'))).status, 404);
    assert.equal((await fetch(d.url('/api/projects/scores'))).status, 404);
  } finally { d.close(); }
});

test('dreams est un module du catalogue, désactivable comme les autres', () => {
  const entry = CATALOG.find((m) => m.id === '@timon/dreams');
  assert.ok(entry, 'dreams doit figurer au catalogue');
  assert.equal(entry.tier, 'std');
  assert.notEqual(entry.tier, 'core');
});
