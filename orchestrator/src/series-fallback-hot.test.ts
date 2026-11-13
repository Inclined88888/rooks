/**
 * Règle de repli posée À CHAUD : elle déplace les tasks, tout de suite.
 *
 * Le geste que ces tests verrouillent est celui de la nuit du 2026-09-01 —
 * `rooks series fallback set --scope code --backend claude` posé en plein
 * incident. À l'époque il ne faisait qu'ÉCRIRE la cible : la task suivante est
 * repartie sous le backend mort, et il a fallu réécrire `backend_override`
 * task par task. Ce qui est vérifié ici, dans l'ordre : la portée nommée bouge,
 * les autres non, la task bloquée par le backend repart, et un pilote en bonne
 * santé n'est pas permuté au passage.
 *
 * `node --test --import tsx src/series-fallback-hot.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-fallback-hot-test-'));
process.env.ROOKS_FALLBACK_ENABLED = '1';
process.env.ROOKS_FALLBACK_BACKEND = 'codex';
process.env.ROOKS_FALLBACK_MODEL = '';

const { dbApi } = await import('./db.js');
const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
// A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
await stubCliBinaries('grok', 'claude', 'codex');
await stubCodexSignIn();
await mountOfficialProviders();
const { applySeriesFallbackRule, clearBackendCooldown } = await import('./backend-fallback.js');
const { upsertAgent, killAgent } = await import('./agent.js');
const { getHost } = await import('./host/index.js');
const { registerRoutes } = await import('./plugins-bundled/kanban/routes.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');

// A pilot's handover only counts once its turn starts: `p.main` can start one,
// on a CLI that stays up, and `p.nameless` (no system prompt) never can.
upsertAgent({ name: 'p.main', system_prompt: 'Test pilot.', config: {
  cwd: process.env.ROOKS_HOME, backend: 'claude', model: 'opus', skills: [], mcp_servers: [], memory_scope: 'NONE',
} });
const host = getHost();
const originalSpawn = host.spawn;
host.spawn = (() => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  child.pid = 4242;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true; };
  return child;
}) as typeof host.spawn;
test.after(() => { host.spawn = originalSpawn; });

/** Une série en cours : un pilote, un volet code et une review, tous sur grok. */
function series(opts: { codeStatus?: 'PENDING' | 'BLOCKED'; pilotAgent?: string } = {}) {
  const seriesId = randomUUID();
  const pilotId = randomUUID();
  const codeId = randomUUID();
  const reviewId = randomUUID();
  dbApi.createMission(pilotId, opts.pilotAgent ?? 'p.main', 'pilote de la série');
  // Le pilote tourne lui aussi sur grok : sans backend explicite il retomberait
  // sur le défaut du dépôt, et une bascule vers claude serait un simple
  // changement de modèle — le test ne prouverait plus rien de la permutation.
  dbApi.setMissionLlmOverrides(pilotId, 'grok', 'grok-4.6');
  for (const [id, type, title] of [[codeId, 'code', 'volet coder'], [reviewId, 'review', 'review du volet']] as const) {
    dbApi.createTask(id, title, 'p.coder', {
      type, seriesId, creatorMissionId: pilotId,
      backendOverride: 'grok', modelOverride: 'grok-4.6',
    });
  }
  if (opts.codeStatus === 'BLOCKED') {
    dbApi.setTaskInterrupted(codeId, 'exhausted', 'compte sans crédit (HTTP 402)');
  }
  return { seriesId, pilotId, codeId, reviewId };
}

test('une règle posée à chaud déplace les tasks de sa portée, et elles seules', async () => {
  const { seriesId, codeId, reviewId } = series();
  dbApi.setSeriesFallback(seriesId, 'code', 'claude', 'opus');

  const applied = await applySeriesFallbackRule(seriesId, 'code');

  assert.deepEqual(applied, { backend: 'claude', model: 'opus' });
  assert.equal(dbApi.getTask(codeId)?.backend_override, 'claude');
  assert.equal(dbApi.getTask(codeId)?.model_override, 'opus');
  // La review n'était pas nommée. Sans ce garde-fou elle partirait quand même,
  // par le joker, la matrice d'équivalence ou le réglage global — trois cibles
  // que l'humain n'a pas demandées en tapant `--scope code`.
  assert.equal(dbApi.getTask(reviewId)?.backend_override, 'grok');
});

test('une task bloquée par le backend repart en file, la règle appliquée', async () => {
  const { seriesId, codeId } = series({ codeStatus: 'BLOCKED' });
  assert.equal(dbApi.getTask(codeId)?.status, 'BLOCKED');
  dbApi.setSeriesFallback(seriesId, 'code', 'claude', null);

  await applySeriesFallbackRule(seriesId, 'code');

  const moved = dbApi.getTask(codeId);
  assert.equal(moved?.backend_override, 'claude');
  // Le fond du problème corrigé ici : la règle appliquée sans remise en file
  // laisse la task BLOCKED sur un plan de repli déjà posé — du travail
  // déplaçable que plus personne ne déplace.
  assert.equal(moved?.status, 'PENDING');
  assert.equal(moved?.interrupted_reason, null);
});

test('un pilote en bonne santé n’est pas permuté par une règle qui vise le code', async () => {
  const { seriesId, pilotId } = series();
  clearBackendCooldown('grok');
  dbApi.setSeriesFallback(seriesId, 'code', 'claude', null);

  await applySeriesFallbackRule(seriesId, 'code');

  // `switchMissionBackend` rejoue le transcript d'une mission VIVANTE : le
  // faire parce qu'on a réglé le repli du coder couperait l'orchestrateur en
  // plein plan, sans que rien ne le lui ait demandé.
  assert.equal(dbApi.getMission(pilotId)?.backend_override, 'grok');
});

test('un pilote dont le backend est à sec bascule, lui, quelle que soit la portée', async () => {
  const { seriesId, pilotId } = series();
  dbApi.setBackendCooldown('grok', Date.now() + 3600_000, 'balance exhausted', false, 'exhausted');
  dbApi.setSeriesFallback(seriesId, 'code', 'claude', null);
  dbApi.setSeriesFallback(seriesId, 'orchestrator', 'claude', 'opus');
  try {
    await applySeriesFallbackRule(seriesId, 'code');
    // Le pilote mort, plus aucun retour de task n'est traité : c'est la cascade
    // de l'incident du 2026-08-20. On ne le laisse pas sur un backend à sec sous
    // prétexte que la règle nommait le coder.
    assert.equal(dbApi.getMission(pilotId)?.backend_override, 'claude');
  } finally {
    clearBackendCooldown('grok');
    await killAgent(pilotId, { source: 'test' });
  }
});

test('a pilot whose fallback cannot start stays where it was, and the tasks still move', async () => {
  const { seriesId, pilotId, codeId } = series({ pilotAgent: 'p.nameless' });
  dbApi.setMissionSession(pilotId, 'pilot-session');
  dbApi.setBackendCooldown('grok', Date.now() + 3600_000, 'balance exhausted', false, 'exhausted');
  dbApi.setSeriesFallback(seriesId, 'code', 'claude', null);
  dbApi.setSeriesFallback(seriesId, 'orchestrator', 'claude', 'opus');
  try {
    await applySeriesFallbackRule(seriesId, 'code');
    // No handover happened: its session stays resumable, and the next wake,
    // still on a dry backend, tries the fallback again.
    const pilot = dbApi.getMission(pilotId);
    assert.equal(pilot?.backend_override, 'grok');
    assert.equal(pilot?.model_override, 'grok-4.6');
    assert.equal(pilot?.session_id, 'pilot-session');
    assert.equal(dbApi.listEvents(pilotId).filter((e) => e.type === 'backend_switch').length, 0);
    assert.equal(dbApi.getTask(codeId)?.backend_override, 'claude');
  } finally {
    clearBackendCooldown('grok');
  }
});

test('la portée orchestrateur, elle, vise bien le pilote et lui seul', async () => {
  const { seriesId, pilotId, codeId, reviewId } = series();
  dbApi.setSeriesFallback(seriesId, 'orchestrator', 'claude', 'opus');

  await applySeriesFallbackRule(seriesId, 'orchestrator');

  assert.equal(dbApi.getMission(pilotId)?.backend_override, 'claude');
  assert.equal(dbApi.getMission(pilotId)?.model_override, 'opus');
  // Aucune task ne bouge : `orchestrator` ne gouverne aucun type de task, et
  // ne tombe jamais dans le joker `'*'` (cf. `seriesRule`).
  assert.equal(dbApi.getTask(codeId)?.backend_override, 'grok');
  assert.equal(dbApi.getTask(reviewId)?.backend_override, 'grok');
  await killAgent(pilotId, { source: 'test' });
});

/** La route Kanban montée nue : c'est elle qui porte le défaut `apply`. */
async function withApi<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  // The series routes refuse an anonymous caller (same guard as `/roles`): the
  // test speaks as the daemon, like the CLI does.
  app.use(createDaemonAuthMiddleware({ token: 'hot-test', required: false }));
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('la route applique par défaut, et ne touche à rien avec apply:false', async () => {
  const noApply = series();
  const byDefault = series();

  await withApi(async (base) => {
    const put = (seriesId: string, body: Record<string, unknown>) =>
      fetch(`${base}/api/series/${seriesId}/fallbacks`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer hot-test' },
        body: JSON.stringify({ scope: 'code', backend: 'claude', ...body }),
      }).then((r) => r.json() as Promise<{ applied: { backend: string } | null }>);

    // `apply: false` : la règle est écrite, les tasks en cours ne bougent pas.
    const recorded = await put(noApply.seriesId, { apply: false });
    assert.equal(recorded.applied, null);
    assert.equal(dbApi.getSeriesFallback(noApply.seriesId, 'code')?.backend, 'claude');
    assert.equal(dbApi.getTask(noApply.codeId)?.backend_override, 'grok');

    // Rien de précisé : on applique. C'est le geste manqué du 2026-09-01.
    const applied = await put(byDefault.seriesId, {});
    assert.equal(applied.applied?.backend, 'claude');
    assert.equal(dbApi.getTask(byDefault.codeId)?.backend_override, 'claude');
  });
});
