/**
 * Base de worktree choisie à la CRÉATION de la task.
 *
 * Sans elle, `createWorktree` retombe sur la branche courante du dépôt — et le
 * dépôt est partagé par tous les agents du projet. Un worktree pouvait donc
 * démarrer sur la branche d'un autre agent, et le merge d'un pipeline
 * `code-self` atterrir sur son travail. C'est ce qui a coûté la soirée du
 * 2026-09-05.
 *
 * `node --test --import tsx src/task-base-branch.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-task-base-test-'));

const { dbApi } = await import('./db.js');
const { createWorktree } = await import('./worktree.js');
const { registerRoutes } = await import('./plugins-bundled/kanban/routes.js');

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** Un dépôt avec `main` et la branche d'un autre agent, SUR LAQUELLE il est
 *  resté positionné — l'état réel d'un repo partagé en pleine série. */
function sharedRepo(): { dir: string; mainSha: string; otherSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'timon-base-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@timon.local');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'a.txt'), 'un\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const mainSha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'timon/task/autre-agent');
  writeFileSync(join(dir, 'b.txt'), 'deux\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'travail en cours d\'un autre agent');
  return { dir, mainSha, otherSha: git(dir, 'rev-parse', 'HEAD') };
}

async function withApi<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  // The operator: writing a task needs an identity holding kanban:write (TODO #752).
  app.use((req, _res, next) => { req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true }; next(); });
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try { return await fn(`http://127.0.0.1:${port}`); } finally { server.close(); }
}

function create(base: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'volet', agent_name: 'p.coder', type: 'code', ...body }),
  });
}

test('la base demandée est persistée en base_branch dès la création', async () => {
  await withApi(async (api) => {
    const r = await create(api, { base: 'main' });
    assert.equal(r.status, 201);
    const { task } = await r.json() as { task: { id: string } };
    assert.equal(dbApi.getTask(task.id)?.base_branch, 'main');
  });
});

test('sans base, rien n\'est posé : le comportement d\'avant est intact', async () => {
  await withApi(async (api) => {
    const { task } = await (await create(api, {})).json() as { task: { id: string } };
    assert.equal(dbApi.getTask(task.id)?.base_branch, null);
  });
});

test('une base douteuse est refusée : elle deviendrait un argument de git', async () => {
  await withApi(async (api) => {
    for (const base of ['--force', 'main branch', '../evil', 'main.lock', 'main/']) {
      const r = await create(api, { base });
      assert.equal(r.status, 400, `base "${base}" aurait dû être refusée`);
    }
  });
});

test('le worktree part de la base demandée, pas de la branche d\'un autre agent', async () => {
  const repo = sharedRepo();
  // Le dépôt est resté sur la branche de l'autre agent : c'est la situation
  // exacte où le défaut "branche courante" se retourne contre nous.
  assert.equal(git(repo.dir, 'rev-parse', 'HEAD'), repo.otherSha);

  const wanted = await createWorktree(randomUUID(), repo.dir, 'main');
  assert.equal(wanted.base, 'main');
  assert.equal(git(wanted.path, 'rev-parse', 'HEAD'), repo.mainSha);

  // Et sans base : on hérite bien de la branche courante — le défaut documenté,
  // celui qu'un `base` explicite sert précisément à ne pas subir.
  const inherited = await createWorktree(randomUUID(), repo.dir);
  assert.equal(git(inherited.path, 'rev-parse', 'HEAD'), repo.otherSha);
});
