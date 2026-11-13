/**
 * `GET /api/health` is a CONTRACT, not a formality (step 5.6.4).
 *
 * The desktop shell uses it to decide whether Timon is running before it opens
 * a window. On a machine where another daemon holds the port — the v1 on
 * :3000, with a health route of its own — an answer that does not name itself
 * made the shell open a window on an app port nobody served: a blank page and
 * no message. The daemon must say who it is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'timon-routes-test-'));
process.env.TIMON_HOME = HOME;

const express = (await import('express')).default;
const { registerRoutes } = await import('./routes.js');
const { instanceId } = await import('../../host/packaged-service.js');
const { BRAND } = await import('../../brand.js');

test('/api/health names the service that answers', async () => {
  const app = express();
  registerRoutes(app as never);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; service: string; instance: string; packaged: boolean; version: string; builtAt: string | null };
    assert.equal(body.ok, true);
    assert.equal(body.service, BRAND.displayName);
    assert.equal(body.instance, instanceId(HOME));
    assert.equal(body.packaged, false);
    assert.equal(typeof body.version, 'string');
    assert.ok(body.version.length > 0);
    assert.ok(body.builtAt === null || typeof body.builtAt === 'string');
    const desktopModule = new URL('../../../../desktop/src/health.ts', import.meta.url).href;
    const desktop = await import(desktopModule);
    const health = await desktop.probeHealth(`http://127.0.0.1:${addr.port}`);
    assert.equal(desktop.isTimon(health, HOME), true);
    assert.equal(desktop.isTimon(health, join(HOME, 'another-home')), false);
    // TODO #477: a daemon run from the sources says so, and the desktop reads it.
    assert.equal(health.packaged, false);
  } finally {
    server.close();
  }
});

test('/api/health/resources reports the daemon heap next to the cgroup numbers', async () => {
  const app = express();
  registerRoutes(app as never);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health/resources`);
    assert.equal(res.status, 200);
    const body = await res.json() as { daemon?: { heapUsedMb: number; heapLimitMb: number; rssMb: number; sse: { clients: number; busEventListeners: number } } };
    assert.ok(body.daemon, 'a heap that grows has to be readable without attaching a debugger');
    assert.ok(body.daemon.heapUsedMb > 0 && body.daemon.heapUsedMb < body.daemon.heapLimitMb);
    assert.ok(body.daemon.rssMb > 0);
    assert.equal(body.daemon.sse.clients, 0);
  } finally {
    server.close();
  }
});

async function listening() {
  const app = express();
  app.use(express.json());
  registerRoutes(app as never);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  return { base: `http://127.0.0.1:${addr.port}`, server };
}

const CONFIG = join(HOME, 'timon.config.json');

/**
 * `POST /api/onboarding` (step 5.7.3) — the surface where a browser can make
 * this machine run something. What it refuses matters more than what it does.
 */
test('onboarding: seule une action nommée passe, jamais une commande', async () => {
  const { base, server } = await listening();
  try {
    for (const body of [
      { action: 'run', command: 'rm -rf /' },
      { action: 'install-binary', name: 'curl && rm -rf ~' },
      { action: 'install-binary' },
      {},
    ]) {
      const res = await fetch(`${base}/api/onboarding`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `refused: ${JSON.stringify(body)}`);
    }
  } finally {
    server.close();
  }
});

/**
 * L'ordre que cette porte impose au client : installer le service D'ABORD,
 * écrire `timon.config.json` ENSUITE — écrire ce fichier met fin au premier
 * lancement, donc ferme cette route.
 */
test("onboarding: refusé dès qu'une config existe, sans conseiller un CLI absent", async () => {
  const { base, server } = await listening();
  writeFileSync(CONFIG, '{}\n');
  try {
    const res = await fetch(`${base}/api/onboarding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'install-service' }),
    });
    assert.equal(res.status, 409);
    const body = await res.json() as { command?: string };
    assert.equal(body.command, null);
  } finally {
    rmSync(CONFIG, { force: true });
    server.close();
  }
});

test('onboarding: un prérequis privilégié rend la commande à coller', async () => {
  const { base, server } = await listening();
  try {
    const res = await fetch(`${base}/api/onboarding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'install-binary', name: 'git' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; command: string | null; reason: string | null };
    // Sur cette machine (apt) : refusé et montré. Sur une machine sans
    // gestionnaire connu : refusé sans commande. Jamais exécuté dans les deux cas.
    assert.equal(body.ok, false);
    assert.ok(body.reason);
  } finally {
    server.close();
  }
});
