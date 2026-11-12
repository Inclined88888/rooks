/**
 * Promotion d'une idée en task — volet 3/4 du chantier Kanban.
 *
 * Ce que le test garde sous surveillance, parce qu'un renommage ou un refactor
 * futur le casserait en silence : la task naît `PENDING` (donc dispatchable, ce
 * que `project_todo_add` ne fait jamais), l'idée est marquée ET garde le lien
 * vers sa task, et une seconde promotion est refusée en nommant la première.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Router } from 'express';

const todoRoutes = await import('./project-todo-routes.js');
const kanbanRoutes = await import('./routes.js');
const { dbApi } = await import('../../db.js');

async function serve(register: (r: Router) => void): Promise<{ url: (p: string) => string; close: () => void }> {
  const app = express();
  app.use(express.json());
  // The PATCH route requires an authenticated caller: act as the CLI does.
  app.use((req, _res, next) => { req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true }; next(); });
  register(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { url: (p) => `http://127.0.0.1:${port}${p}`, close: () => server.close() };
}

const d = await serve((r) => { kanbanRoutes.registerRoutes(r); todoRoutes.registerRoutes(r); });
dbApi.upsertProject('witness', { cwd: '/tmp' });

async function newIdea(fields: Record<string, unknown> = {}): Promise<number> {
  const r = await fetch(d.url('/api/project-todo'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'idée mûre', project: 'witness', notes: 'le contexte', ...fields }),
  });
  assert.equal(r.status, 201);
  return ((await r.json()) as { item: { id: number } }).item.id;
}

async function promote(id: number, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(d.url(`/api/project-todo/${id}/promote`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_name: 'witness.coder', ...body }),
  });
}

test('promouvoir crée une task PENDING et marque l\'idée, lien compris', async () => {
  const id = await newIdea();
  const r = await promote(id, { type: 'code', base: 'main', priority: 4, pipeline: 'code-self' });
  assert.equal(r.status, 201);
  const { task, item } = (await r.json()) as {
    task: { id: string; status: string; title: string; type: string; priority: number; pipeline: string | null; agent_name: string };
    item: { status: string; promoted_task_id: string | null };
  };
  // PENDING : c'est TOUTE la différence avec `project_todo_add`, qui n'expose
  // jamais l'idée au dispatcher.
  assert.equal(task.status, 'PENDING');
  assert.equal(task.title, 'idée mûre');
  assert.equal(task.type, 'code');
  assert.equal(task.priority, 4);
  assert.equal(task.pipeline, 'code-self');
  assert.equal(task.agent_name, 'witness.coder');
  // L'idée n'est ni supprimée ni laissée ouverte.
  assert.equal(item.status, 'promoted');
  assert.equal(item.promoted_task_id, task.id);
  const reread = dbApi.getProjectTodo(id);
  assert.equal(reread?.promoted_task_id, task.id, 'le lien est en base, pas seulement dans la réponse');
  // La provenance voyage aussi dans le brief : l'agent ne lit pas la base.
  const created = dbApi.getTask(task.id);
  assert.equal(created?.base_branch, 'main', 'la base du worktree suit, comme pour kanban_add');
  assert.match(created?.description ?? '', /idea #\d+ of the project.s TO DO notebook/);
  assert.match(created?.description ?? '', /le contexte/);
});

test('une idée déjà promue ne se promeut pas deux fois', async () => {
  const id = await newIdea();
  assert.equal((await promote(id)).status, 201);
  const second = await promote(id);
  assert.equal(second.status, 409);
  const body = (await second.json()) as { error: string; task_id: string };
  assert.match(body.error, /already promoted/);
  assert.equal(body.task_id, dbApi.getProjectTodo(id)?.promoted_task_id);
  // Une seule task pour cette idée : la garde ne se contente pas de répondre 409.
  const forIdea = dbApi.listTasks().filter((t) => (t.description ?? '').includes(`idea #${id} of the project`));
  assert.equal(forIdea.length, 1);
});

test('le statut « promoted » ne se pose pas par PATCH', async () => {
  const id = await newIdea();
  const r = await fetch(d.url(`/api/project-todo/${id}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'promoted' }),
  });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /promote/);
  assert.equal(dbApi.getProjectTodo(id)?.promoted_task_id, null);
});

test('une idée remise à « open » après promotion reste promue pour la garde', async () => {
  const id = await newIdea();
  assert.equal((await promote(id)).status, 201);
  const back = await fetch(d.url(`/api/project-todo/${id}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'open' }),
  });
  assert.equal(back.status, 200);
  // Le lien fait foi, pas le statut : sans ça, un PATCH rouvrirait la porte à
  // une seconde task et orphelinerait la première.
  assert.equal((await promote(id)).status, 409);
});

test('promouvoir sans agent est refusé — la task ne devine pas son exécutant', async () => {
  const id = await newIdea();
  const r = await fetch(d.url(`/api/project-todo/${id}/promote`), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /agent_name/);
});

test('idée rattachée à un projet inconnu : l\'erreur parle de l\'idée', async () => {
  const id = await newIdea({ project: 'projet-fantome' });
  const r = await promote(id);
  assert.equal(r.status, 400);
  const { error } = (await r.json()) as { error: string };
  assert.match(error, new RegExp(`idea #${id}`));
  assert.match(error, /projet-fantome/);
  assert.equal(dbApi.getProjectTodo(id)?.promoted_task_id, null, 'rien de promu quand rien n\'est créé');
  // Le projet passé explicitement débloque la promotion sans toucher à l'idée.
  assert.equal((await promote(id, { project: 'witness' })).status, 201);
});

test('on peut lister ce qui est parti au tableau', async () => {
  const id = await newIdea();
  assert.equal((await promote(id)).status, 201);
  const r = await fetch(d.url('/api/project-todo?status=promoted'));
  assert.equal(r.status, 200);
  const { items } = (await r.json()) as { items: { id: number }[] };
  assert.ok(items.some((i) => i.id === id));
  // `open` ne les ramène pas : la colonne "TO DO" du Kanban ne les montre plus.
  const open = (await (await fetch(d.url('/api/project-todo?status=open'))).json()) as { items: { id: number }[] };
  assert.equal(open.items.some((i) => i.id === id), false);
});

test('promouvoir n\'est pas le handoff — les deux gestes coexistent', async () => {
  // `handoff` envoie un MESSAGE à `<projet>.main` pour en discuter ; ici aucun
  // agent n'existe on-disk, donc il refuse. La promotion, elle, passe.
  const id = await newIdea();
  const handoff = await fetch(d.url(`/api/project-todo/${id}/handoff`), { method: 'POST' });
  assert.equal(handoff.status, 400);
  assert.equal((await promote(id)).status, 201);
});

test.after(() => d.close());
