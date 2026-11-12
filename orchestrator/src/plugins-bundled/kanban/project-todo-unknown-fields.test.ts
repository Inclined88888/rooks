/**
 * PATCH /api/project-todo/:id and POST /api/project-todo reject unknown fields
 * with a 400 that names the field and lists the accepted ones.
 *
 * Context: an agent called project_todo_update with `resolution_note` (the
 * correct field is `public_note`). The field was silently ignored, the
 * `declined` resolution was sent without a note, and the note written
 * afterwards was never announced.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Router } from 'express';

const routes = await import('./project-todo-routes.js');

async function serve(register: (r: Router) => void): Promise<{ url: (p: string) => string; close: () => void }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true }; next(); });
  register(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { url: (p) => `http://127.0.0.1:${port}${p}`, close: () => server.close() };
}

const json = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const patch = (body: unknown): RequestInit => ({ ...json(body), method: 'PATCH' });

// ── PATCH ──────────────────────────────────────────────────────────────────

test('PATCH: unknown field refused with 400 naming the field', async () => {
  const d = await serve(routes.registerRoutes);
  try {
    const { item } = await (await fetch(d.url('/api/project-todo'), json({ text: 'idea' }))).json();
    const r = await fetch(d.url(`/api/project-todo/${item.id}`), patch({ resolution_note: 'oops' }));
    assert.equal(r.status, 400);
    const body = await r.json() as { error: string };
    assert.match(body.error, /resolution_note/, 'error must name the unknown field');
    assert.match(body.error, /accepted:/, 'error must list accepted fields');
  } finally { d.close(); }
});

test('PATCH: accepted field names are listed in the error', async () => {
  const d = await serve(routes.registerRoutes);
  try {
    const { item } = await (await fetch(d.url('/api/project-todo'), json({ text: 'idea' }))).json();
    const r = await fetch(d.url(`/api/project-todo/${item.id}`), patch({ typo_field: 'x' }));
    assert.equal(r.status, 400);
    const body = await r.json() as { error: string };
    // Core fields must appear in the list
    for (const f of ['text', 'notes', 'status', 'urgency', 'progress']) {
      assert.match(body.error, new RegExp(f), `"${f}" must be listed as accepted`);
    }
  } finally { d.close(); }
});

test('PATCH: extension fields (public_note, resolution, duplicate_of) are accepted', async () => {
  // Register a minimal extension so the fields are known at request time.
  const { registerTodoExtension } = await import('../../project-todo-extensions.js');
  const dispose = registerTodoExtension({
    id: 'test-ext',
    fields: ['resolution', 'public_note', 'duplicate_of'],
    prepare: (_existing, _body, _core) => null,
  });
  const d = await serve(routes.registerRoutes);
  try {
    const { item } = await (await fetch(d.url('/api/project-todo'), json({ text: 'idea' }))).json();
    // Each extension field alone: must NOT be rejected as unknown
    for (const field of ['public_note', 'resolution', 'duplicate_of']) {
      const r = await fetch(d.url(`/api/project-todo/${item.id}`), patch({ [field]: null }));
      assert.notEqual(r.status, 400, `extension field "${field}" should not be rejected as unknown`);
    }
  } finally {
    d.close();
    dispose();
  }
});

test('PATCH: known fields still accepted, no regression', async () => {
  const d = await serve(routes.registerRoutes);
  try {
    const { item } = await (await fetch(d.url('/api/project-todo'), json({ text: 'idea' }))).json();
    const r = await fetch(d.url(`/api/project-todo/${item.id}`), patch({ text: 'updated text', status: 'done' }));
    assert.equal(r.status, 200);
    const body = await r.json() as { item: { text: string; status: string } };
    assert.equal(body.item.text, 'updated text');
    assert.equal(body.item.status, 'done');
  } finally { d.close(); }
});

// ── POST ───────────────────────────────────────────────────────────────────

test('POST: unknown field refused with 400 naming the field', async () => {
  const d = await serve(routes.registerRoutes);
  try {
    const r = await fetch(d.url('/api/project-todo'), json({ text: 'idea', unknown_field: 'x' }));
    assert.equal(r.status, 400);
    const body = await r.json() as { error: string };
    assert.match(body.error, /unknown_field/, 'error must name the unknown field');
    assert.match(body.error, /accepted:/, 'error must list accepted fields');
  } finally { d.close(); }
});

test('POST: known fields still accepted, no regression', async () => {
  const d = await serve(routes.registerRoutes);
  try {
    const r = await fetch(d.url('/api/project-todo'), json({ text: 'idea', urgency: 'bug', progress: 'todo' }));
    assert.equal(r.status, 201);
    const body = await r.json() as { item: { text: string; urgency: string } };
    assert.equal(body.item.text, 'idea');
    assert.equal(body.item.urgency, 'bug');
  } finally { d.close(); }
});
