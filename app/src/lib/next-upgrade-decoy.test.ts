/**
 * Next attaches its own `upgrade` listener to the server of the first request
 * it handles, and in production that listener destroys the sockets it does
 * not route — the built-in terminal looped on "Connection lost" because of it
 * (08/10/2026). `server.ts` hands Next a decoy `httpServer`; this pins both
 * the trap (so a Next upgrade that changes it is noticed) and the way out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import next from 'next';

async function upgradeListenersAfterOneRequest(withDecoy: boolean): Promise<number> {
  const server = http.createServer();
  const decoy = http.createServer();
  const app = next({ dev: false, dir: process.cwd(), ...(withDecoy ? { httpServer: decoy } : {}) });
  server.on('upgrade', () => {});
  const req = new http.IncomingMessage(new (await import('node:net')).Socket());
  Object.defineProperty(req.socket, 'server', { value: server });
  const res = new http.ServerResponse(req);
  // No build here: the handler fails after Next has hooked its listener, which is all we watch.
  await app.getRequestHandler()(req, res).catch(() => undefined);
  return server.listenerCount('upgrade');
}

test('without a decoy, Next adds its own upgrade listener to our server', async () => {
  assert.equal(await upgradeListenersAfterOneRequest(false), 2);
});

test('with the decoy, our upgrade listener stays the only one', async () => {
  assert.equal(await upgradeListenersAfterOneRequest(true), 1);
});

test('server.ts hands Next the decoy', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'server.ts'), 'utf8');
  assert.match(source, /next\(\{[^}]*httpServer: nextUpgradeDecoy/);
});
