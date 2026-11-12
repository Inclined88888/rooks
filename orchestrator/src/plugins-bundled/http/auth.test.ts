/**
 * 4.1 + 4.3 — jeton daemon et middleware d'auth.
 *
 * Aucun bind sur le :3000 de prod : les serveurs témoins écoutent
 * `127.0.0.1:0`. Le child qui vérifie le code 2 a `PORT=0` et un
 * `ROOKS_HOME` jetable ; on ne le `kill` que s'il a un pid, jamais `0`.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-daemon-auth-test-'));
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { authIsRequired, createDaemonAuthMiddleware, ensureDaemonToken, DAEMON_TOKEN_FILE } =
  await import('./auth.js');
const { loadConfig, ConfigError } = await import('../../config/load.js');
const { ZONES } = await import('../../paths.js');

function writeConfig(obj: unknown): string {
  const file = join(process.env.ROOKS_HOME!, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

async function listenApp(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr === 'string') throw new Error('adresse d\'écoute inattendue');
  assert.notEqual(addr.port, 3000, 'le témoin ne doit pas prendre le port de prod');
  return {
    port: addr.port,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

function appWithAuth(opts: { token: string; required: boolean }): express.Express {
  const app = express();
  app.use(createDaemonAuthMiddleware(opts));
  app.use(express.json({ limit: '25mb' }));
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/health/resources', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/stats', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/stream', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/missions/:id/stream', (_req, res) => { res.json({ ok: true }); });
  return app;
}

test('fichier absent : jeton 64 hex, mode 0600, sous ROOKS_HOME', () => {
  const token = ensureDaemonToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(DAEMON_TOKEN_FILE, 'utf8').trim(), token);
  assert.equal(statSync(DAEMON_TOKEN_FILE).mode & 0o777, 0o600);
  assert.equal(DAEMON_TOKEN_FILE, join(process.env.ROOKS_HOME!, 'daemon-token'));
  assert.ok(ZONES.secrets.includes('daemon-token'));
});

test('fichier déjà là : le jeton existant est conservé', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rooks-daemon-token-reuse-'));
  const file = join(dir, 'daemon-token');
  writeFileSync(file, 'jeton-impose-par-l-operateur\n', { mode: 0o600 });
  assert.equal(ensureDaemonToken(file), 'jeton-impose-par-l-operateur');
  assert.equal(readFileSync(file, 'utf8').trim(), 'jeton-impose-par-l-operateur');
});

test('authIsRequired : auto + 0.0.0.0 = oui ; auto + 127.0.0.1 = non ; required = oui', () => {
  const at = (auth: 'auto' | 'required' | 'off', host: string, appHost = '127.0.0.1', behindTlsProxy = false) =>
    authIsRequired({ daemon: { auth, listen: { host }, behindTlsProxy }, app: { listen: { host: appHost } } });
  assert.equal(at('auto', '0.0.0.0'), true);
  assert.equal(at('auto', '127.0.0.1'), false);
  assert.equal(at('required', '127.0.0.1'), true);
  assert.equal(at('off', '127.0.0.1'), false);
  assert.equal(at('off', '127.0.0.1', '0.0.0.0'), true);
  // TODO #346: the Next proxy and a TLS reverse proxy reach a loopback daemon
  // on behalf of remote visitors.
  assert.equal(at('auto', '127.0.0.1', '0.0.0.0'), true);
  assert.equal(at('auto', '127.0.0.1', '10.0.0.5'), true);
  assert.equal(at('auto', '127.0.0.1', '127.0.0.1', true), true);
  assert.equal(at('auto', '127.0.0.1', 'localhost'), false);
});

test('WebUI exposée, daemon en loopback : un anonyme est refusé avant même le premier compte', async () => {
  const cfg = loadConfig(writeConfig({
    daemon: { listen: { host: '127.0.0.1' }, auth: 'auto' },
    app: { listen: { host: '0.0.0.0' } },
  }));
  const token = ensureDaemonToken();
  const { port, close } = await listenApp(appWithAuth({ token, required: authIsRequired(cfg) }));
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/stats`)).status, 401);
    assert.equal((await fetch(`${base}/api/stats`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  } finally {
    await close();
  }
});

test('listen 0.0.0.0 : sans token = 401, avec Bearer = 200, health public', async () => {
  const cfg = loadConfig(writeConfig({ daemon: { listen: { host: '0.0.0.0' }, auth: 'auto' } }));
  const token = ensureDaemonToken();
  const { port, close } = await listenApp(appWithAuth({ token, required: authIsRequired(cfg) }));
  try {
    const base = `http://127.0.0.1:${port}`;

    const noTok = await fetch(`${base}/api/stats`);
    assert.equal(noTok.status, 401);
    assert.deepEqual(await noTok.json(), { error: 'unauthorized' });

    const withTok = await fetch(`${base}/api/stats`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(withTok.status, 200);
    assert.deepEqual(await withTok.json(), { ok: true });

    const viaQuery = await fetch(`${base}/api/stats?token=${encodeURIComponent(token)}`);
    assert.equal(viaQuery.status, 401, '?token= ne doit pas authentifier hors SSE');

    const wrong = await fetch(`${base}/api/stats`, {
      headers: { authorization: 'Bearer deadbeef' },
    });
    assert.equal(wrong.status, 401);

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const resources = await fetch(`${base}/api/health/resources`);
    assert.equal(resources.status, 401);
  } finally {
    await close();
  }
});

test('auth auto + 127.0.0.1 : pas de jeton exigé tant que la table users est vide', async () => {
  const cfg = loadConfig(writeConfig({ daemon: { listen: { host: '127.0.0.1' }, auth: 'auto' } }));
  const token = ensureDaemonToken();
  const { port, close } = await listenApp(appWithAuth({ token, required: authIsRequired(cfg) }));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/stats`);
    assert.equal(r.status, 200);
  } finally {
    await close();
  }
});

test('loopback with users: anonymous is 401, daemon-token Bearer still works, health stays public', async () => {
  const { dbApi } = await import('../../db.js');
  const { hashPassword } = await import('../../users/password.js');
  assert.equal(dbApi.countUsers(), 0);
  createTestAccount(dbApi, {
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: hashPassword('admin-secret'),
    isSuperadmin: true,
  });
  const token = ensureDaemonToken();
  const { port, close } = await listenApp(appWithAuth({ token, required: false }));
  try {
    const base = `http://127.0.0.1:${port}`;

    const noTok = await fetch(`${base}/api/stats`);
    assert.equal(noTok.status, 401);
    assert.deepEqual(await noTok.json(), { error: 'unauthorized' });

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);

    // CLI / operator still send this header (`ROOKS_API_TOKEN` = daemon-token).
    const agent = await fetch(`${base}/api/stats`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(agent.status, 200);
  } finally {
    await close();
  }
});

/** Boots a real daemon on a throwaway home and returns its exit code and stderr. */
async function bootWith(userConfig: unknown): Promise<{ code: number | null; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'rooks-auth-off-boot-'));
  writeFileSync(join(home, 'rooks.config.json'), JSON.stringify(userConfig));

  const bootTs = fileURLToPath(new URL('../../boot.ts', import.meta.url));
  const orchDir = fileURLToPath(new URL('../../../', import.meta.url));
  const child = spawn('setsid', [process.execPath, '--import', 'tsx', bootTs], {
    cwd: orchDir,
    env: {
      ...process.env,
      ROOKS_HOME: home,
      ROOKS_RESOURCE_GUARD_ENABLED: '0',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk); });

  // Only a boot that never returns trips this: compiling the whole daemon through tsx took more than 25 s on a
  // loaded machine (TODO #605). Under the runner's 120 s per-test limit, so the failure still says why.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (typeof pid === 'number' && pid > 0) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* déjà mort */ }
    }
  }, 90_000);

  const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  clearTimeout(timer);

  assert.equal(timedOut, false, `le boot n'a pas rendu la main : stdout=${stdout} stderr=${stderr}`);
  return { code, stderr };
}

test('auth off + 0.0.0.0 : loadConfig refuse, le daemon sort en code 2', async () => {
  assert.throws(
    () => loadConfig(writeConfig({ daemon: { listen: { host: '0.0.0.0' }, auth: 'off' } })),
    (e: unknown) => e instanceof ConfigError
      && /auth disabled on a non-loopback interface/.test((e as Error).message),
  );

  const { code, stderr } = await bootWith({ daemon: { listen: { host: '0.0.0.0' }, auth: 'off' } });
  assert.equal(code, 2, `code=${code} stderr=${stderr}`);
  assert.match(stderr, /auth disabled on a non-loopback interface/);
});

// TODO #528: a loopback daemon behind an exposed WebUI or a TLS proxy is
// reached on behalf of remote visitors; `off` would hand them the whole API.
test('auth off + WebUI exposée ou proxy TLS : loadConfig refuse, le daemon sort en code 2', async () => {
  for (const appHost of ['0.0.0.0', '10.0.0.5', '::']) {
    assert.throws(
      () => loadConfig(writeConfig({
        daemon: { listen: { host: '127.0.0.1' }, auth: 'off' },
        app: { listen: { host: appHost } },
      })),
      (e: unknown) => e instanceof ConfigError
        && /web interface listens beyond the loopback/.test((e as Error).message),
      appHost,
    );
  }
  assert.throws(
    () => loadConfig(writeConfig({ daemon: { listen: { host: '127.0.0.1' }, auth: 'off', behindTlsProxy: true } })),
    (e: unknown) => e instanceof ConfigError && /behindTlsProxy/.test((e as Error).message),
  );
  // Loopback everywhere: `off` stays the operator's call.
  for (const appHost of ['127.0.0.1', 'localhost', '::1']) {
    const ok = loadConfig(writeConfig({ daemon: { auth: 'off' }, app: { listen: { host: appHost } } }));
    assert.equal(ok.daemon.auth, 'off');
  }

  const { code, stderr } = await bootWith({
    daemon: { listen: { host: '127.0.0.1' }, auth: 'off' },
    app: { listen: { host: '0.0.0.0' } },
  });
  assert.equal(code, 2, `code=${code} stderr=${stderr}`);
  assert.match(stderr, /web interface listens beyond the loopback/);
});

test('auth off forcé en mémoire (sans loadConfig) + WebUI exposée : un anonyme reste refusé', async () => {
  const off = (appHost: string, behindTlsProxy = false) => authIsRequired({
    daemon: { auth: 'off', listen: { host: '127.0.0.1' }, behindTlsProxy },
    app: { listen: { host: appHost } },
  });
  assert.equal(off('0.0.0.0'), true);
  assert.equal(off('127.0.0.1', true), true);
  assert.equal(authIsRequired({
    daemon: { auth: 'off', listen: { host: '0.0.0.0' }, behindTlsProxy: false },
    app: { listen: { host: '127.0.0.1' } },
  }), true);

  const token = ensureDaemonToken();
  const { port, close } = await listenApp(appWithAuth({ token, required: off('0.0.0.0') }));
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/stats`)).status, 401);
    assert.equal((await fetch(`${base}/api/stats`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  } finally {
    await close();
  }
});

test('?token= : refusé hors SSE, accepté sur les deux flux SSE', async () => {
  const cfg = loadConfig(writeConfig({ daemon: { listen: { host: '0.0.0.0' }, auth: 'auto' } }));
  const token = ensureDaemonToken();
  const q = `token=${encodeURIComponent(token)}`;
  const { port, close } = await listenApp(appWithAuth({ token, required: authIsRequired(cfg) }));
  try {
    const base = `http://127.0.0.1:${port}`;

    // Les seules routes qui gardent la porte : EventSource ne pose pas d'en-tête.
    assert.equal((await fetch(`${base}/api/stream?${q}`)).status, 200);
    assert.equal((await fetch(`${base}/api/missions/m1/stream?${q}`)).status, 200);

    // Tout le reste exige Authorization ou le cookie de session.
    assert.equal((await fetch(`${base}/api/stats?${q}`)).status, 401);
    assert.equal((await fetch(`${base}/api/health/resources?${q}`)).status, 401);
    // Pas de préfixe : une route sous /api/stream/ ne bénéficie pas de l'exception.
    assert.equal((await fetch(`${base}/api/stream/x?${q}`)).status, 401);
    // Une méthode d'écriture sur le chemin SSE ne l'ouvre pas non plus.
    assert.equal((await fetch(`${base}/api/stream?${q}`, { method: 'POST' })).status, 401);
  } finally {
    await close();
  }
});
