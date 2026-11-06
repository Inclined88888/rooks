/**
 * Le carnet "TO DO" appartient au Kanban — volet 2/4 du chantier Kanban.
 *
 * Ce test remplace l'ancien `backlog/split.test.ts`, qui vérifiait la
 * séparation qu'on vient de défaire. Ce qu'il garde de lui : le risque d'un
 * déplacement de routes n'est pas le code (verbatim), c'est un chemin monté
 * deux fois ou plus du tout. On monte donc les routeurs SEULS et on regarde ce
 * qu'ils servent.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Router } from 'express';

const todoLaterRoutes = await import('./project-todo-routes.js');
const kanbanRoutes = await import('./routes.js');
const { CATALOG } = await import('../../kernel/catalog.js');
const { RETIRED_IDS, canonicalModuleId, isRetiredModuleId } = await import('../../kernel/legacy-ids.js');

/** Un serveur éphémère par routeur : aucun état partagé entre les tests. */
async function serve(register: (r: Router) => void): Promise<{ url: (p: string) => string; close: () => void }> {
  const app = express();
  app.use(express.json());
  register(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { url: (p) => `http://127.0.0.1:${port}${p}`, close: () => server.close() };
}

test('le Kanban sert le carnet « TO DO » en plus de ses tasks', async () => {
  const d = await serve((r) => { kanbanRoutes.registerRoutes(r); todoLaterRoutes.registerRoutes(r); });
  try {
    assert.equal((await fetch(d.url('/api/project-todo'))).status, 200);
    assert.equal((await fetch(d.url('/api/tasks'))).status, 200);
    // Ce qui est parti dans `dreams` au volet précédent n'est pas revenu ici.
    assert.equal((await fetch(d.url('/api/dreams'))).status, 404);
    assert.equal((await fetch(d.url('/api/projects/scores'))).status, 404);
  } finally { d.close(); }
});

test('les deux routeurs du Kanban ne se marchent pas dessus', async () => {
  // Aucun chemin monté deux fois : le routeur des tasks ignore le carnet, et
  // réciproquement. Un doublon se verrait ici avant de se voir en production.
  const tasks = await serve(kanbanRoutes.registerRoutes);
  try {
    assert.equal((await fetch(tasks.url('/api/project-todo'))).status, 404);
  } finally { tasks.close(); }

  const carnet = await serve(todoLaterRoutes.registerRoutes);
  try {
    assert.equal((await fetch(carnet.url('/api/tasks'))).status, 404);
    assert.equal((await fetch(carnet.url('/api/project-todo'))).status, 200);
  } finally { carnet.close(); }
});

test('@timon/kanban éteint : plus aucune route project-todo', async () => {
  // Le carnet n'a plus d'interrupteur à lui — éteindre le tableau l'emporte,
  // et c'est le seul geste qui le fasse disparaître.
  const d = await serve(() => { /* module absent */ });
  try {
    for (const path of ['/api/project-todo', '/api/project-todo/1', '/api/project-todo/1/handoff']) {
      assert.equal((await fetch(d.url(path))).status, 404, path);
    }
  } finally { d.close(); }
});

test('@timon/backlog n\'est plus un module : ni au catalogue, ni vendu à part', () => {
  assert.equal(CATALOG.some((m) => m.id === '@timon/backlog'), false);
  // Le carnet suit le tableau, qui est libre : il ne se vend plus tout seul.
  assert.equal(CATALOG.find((m) => m.id === '@timon/kanban')?.licensed, undefined);
});

test('une config qui porte encore @timon/backlog n\'éteint pas le Kanban', () => {
  // Id retiré, pas aliasé : le traduire vers `@timon/kanban` transformerait
  // "je ne veux pas du carnet" en "je ne veux pas du tableau".
  assert.equal(RETIRED_IDS.has('@timon/backlog'), true);
  assert.equal(isRetiredModuleId('@timon/backlog'), true);
  assert.equal(canonicalModuleId('@timon/backlog'), '@timon/backlog');
});

test('le module alice a disparu du catalogue, ses deux moitiés lui survivent', () => {
  // Volet 11 : l'identité `alice` retourne à ce qu'elle a toujours été, un
  // agent de l'utilisateur. Ce qui était du code est ici, ou dans `dreams`.
  assert.equal(CATALOG.some((m) => m.id === '@timon/alice'), false);
  assert.ok(CATALOG.some((m) => m.id === '@timon/kanban'));
  assert.ok(CATALOG.some((m) => m.id === '@timon/dreams'));
});

test('todo mutations publish once after writing, addressed to the row owner', async () => {
  const { dbApi } = await import('../../db.js');
  const { bus } = await import('../../bus.js');
  type Event = Extract<import('../../bus.js').BusEvent, { kind: 'plugin_realtime' }>;
  const events: { event: Event; status: string | undefined }[] = [];
  const listener = (event: import('../../bus.js').BusEvent) => {
    if (event.kind !== 'plugin_realtime') return;
    const { id } = event.payload as { id: number };
    events.push({ event, status: dbApi.getProjectTodo(id)?.status });
  };
  const owner = 'todo-realtime-owner';
  const d = await serve((r) => {
    r.use((req, _res, next) => {
      req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: owner, permissions: [] };
      next();
    });
    todoLaterRoutes.registerRoutes(r);
  });
  bus.on('event', listener);
  try {
    const created = await fetch(d.url('/api/project-todo'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Live idea' }),
    });
    assert.equal(created.status, 201);
    const { item } = await created.json() as { item: { id: number } };
    const patch = (status: string) => fetch(d.url(`/api/project-todo/${item.id}`), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }),
    });
    assert.equal((await patch('done')).status, 200);
    assert.equal((await patch('promoted')).status, 400);
    assert.equal(events.length, 2);
    assert.equal((await fetch(d.url(`/api/project-todo/${item.id}`), { method: 'DELETE' })).status, 200);
    assert.equal((await patch('open')).status, 404);
    assert.equal((await fetch(d.url(`/api/project-todo/${item.id}`), { method: 'DELETE' })).status, 404);
    assert.deepEqual(events.map(({ status }) => status), ['open', 'done', undefined]);
    for (const { event } of events) {
      assert.deepEqual(event, {
        kind: 'plugin_realtime', pluginId: '@timon/kanban', topic: 'project-todo.changed',
        ownerUserId: owner, payload: { id: item.id },
      });
    }
  } finally { bus.off('event', listener); d.close(); }
});

test('system-owned todo rows never publish realtime', async () => {
  const { bus } = await import('../../bus.js');
  let count = 0;
  const listener = (event: import('../../bus.js').BusEvent) => { if (event.kind === 'plugin_realtime') count++; };
  const d = await serve((r) => {
    // Authenticated edit (the PATCH route requires it) on a row created
    // without an account: a superadmin on the POST would own the row.
    r.use((req, _res, next) => {
      if (req.method === 'PATCH') req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true };
      next();
    });
    todoLaterRoutes.registerRoutes(r);
  });
  bus.on('event', listener);
  try {
    const response = await fetch(d.url('/api/project-todo'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'System idea' }),
    });
    assert.equal(response.status, 201);
    const { item } = await response.json() as { item: { id: number; owner_user_id: null } };
    assert.equal(item.owner_user_id, null);
    assert.equal((await fetch(d.url(`/api/project-todo/${item.id}`), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
    })).status, 200);
    assert.equal((await fetch(d.url(`/api/project-todo/${item.id}`), { method: 'DELETE' })).status, 200);
    assert.equal(count, 0);
  } finally { bus.off('event', listener); d.close(); }
});
