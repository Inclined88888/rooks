/**
 * TODO #580 — an `async` route handler that rejects must not take the daemon
 * down. Express 4 drops a handler's promise, so the rejection used to be
 * unhandled and Node exited with code 1, missions included. Witness server on
 * 127.0.0.1:0, isolated TIMON_HOME, real auth middleware and real mount path
 * (`ctx.http.router()` for a bundled module, `ctx.router()` + `daemonHost`
 * for a third-party plugin).
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createHttpPlugin } = await import('./http-service.js');
const { catchAsyncHandlers } = await import('./async-routes.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { createPluginContext, daemonHost } = await import('../plugins/context.js');
const { readManifest } = await import('../plugins/manifest.js');

const TOKEN = 'witness-daemon-token';
const SECRET = 'sk-witness-secret-must-not-leak';

// Any rejection that escapes would kill a real daemon; here it is recorded so
// the test fails instead of the runner dying mid-file.
const escaped: unknown[] = [];
const onUnhandled = (reason: unknown) => { escaped.push(reason); };
process.on('unhandledRejection', onUnhandled);

const logged: string[] = [];
const consoleError = console.error;
console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
const root = new Context();
await root.plugin(createHttpPlugin(app));

// A bundled module, through the kernel's own router.
let reachedByAnonymous = false;
const bundled = root.http.router('/api/witness');
bundled.get('/boom', async () => { reachedByAnonymous = true; throw new Error(`boom ${SECRET}`); });
bundled.get('/falsy', async () => { await Promise.reject(undefined); });
bundled.get('/client', async () => { throw Object.assign(new Error('bad input'), { status: 400 }); });
bundled.get('/after-headers', async (_req, res) => {
  res.status(200).write('partial');
  throw new Error('late failure');
});
bundled.get('/ok', (_req, res) => void res.json({ ok: true }));
bundled.route('/chained').get(async () => { throw new Error('chained'); });
bundled.get('/handled', async () => { throw new Error('first'); });
bundled.use(async (err: unknown, _req: Request, _res: Response, _next: NextFunction) => {
  if ((err as Error).message !== 'first') throw err;
  // An async error handler that rejects in its turn must not escape either.
  await Promise.resolve();
  throw new Error('second');
});

// A third-party plugin, mounted the way the loader mounts it.
const manifested = readManifest({ timon: { id: 'witness-async', apiVersion: 12, kind: 'behavior', permissions: [] } });
if (!manifested.ok) throw new Error(manifested.message);
const plugin = createPluginContext(new Context(), { manifest: manifested.manifest, version: '1.0.0' }, daemonHost(root));
plugin.router().get('/boom', async () => { throw new Error('plugin failure'); });

// A route set on the app itself, outside any module shell.
app.get('/api/bare', async () => { throw new Error('bare'); });

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  console.error = consoleError;
  process.off('unhandledRejection', onUnhandled);
});

async function get(path: string, bearer: string | null = TOKEN) {
  const res = await fetch(`${base}${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
  return { status: res.status, text: await res.text() };
}

/** A rejection is a microtask behind the response: let it surface first. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('an anonymous caller is refused before the failing handler ever runs', async () => {
  const res = await get('/api/witness/boom', null);
  assert.equal(res.status, 401);
  assert.equal(reachedByAnonymous, false, 'auth stays in front of the handler');
  const forged = await get('/api/witness/boom', 'not-the-token');
  assert.equal(forged.status, 401);
  assert.equal(reachedByAnonymous, false);
});

test('a rejected async handler answers 500, without the error message, and the daemon keeps serving', async () => {
  const res = await get('/api/witness/boom');
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.text), { error: 'internal_error' });
  assert.ok(!res.text.includes(SECRET), 'the error message never reaches the caller');
  assert.ok(logged.some((line) => line.includes('/api/witness/boom') && line.includes('failed')), 'logged server-side');

  const after = await get('/api/witness/ok');
  assert.equal(after.status, 200);
  await settle();
  assert.deepEqual(escaped, []);
});

test('a third-party plugin route that rejects is logged under the plugin and answered 500', async () => {
  logged.length = 0;
  const res = await get('/api/plugins/witness-async/boom');
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.text), { error: 'internal_error' });
  assert.ok(logged.some((line) => line.includes('plugin:witness-async')), `log names the plugin: ${logged.join(' | ')}`);
  await settle();
  assert.deepEqual(escaped, []);
});

test('a rejection without a reason still fails the request', async () => {
  const res = await get('/api/witness/falsy');
  assert.equal(res.status, 500);
  await settle();
  assert.deepEqual(escaped, []);
});

test('a client error keeps its 4xx status', async () => {
  const res = await get('/api/witness/client');
  assert.equal(res.status, 400);
  await settle();
  assert.deepEqual(escaped, []);
});

test('a rejection after the headers left closes the response instead of crashing', async () => {
  const res = await get('/api/witness/after-headers');
  assert.equal(res.status, 200);
  assert.equal(res.text, 'partial');
  await settle();
  assert.deepEqual(escaped, []);
});

test('route() chains and async error handlers are covered too', async () => {
  assert.equal((await get('/api/witness/chained')).status, 500);
  assert.equal((await get('/api/witness/handled')).status, 500);
  await settle();
  assert.deepEqual(escaped, []);
});

test('a route set on the app itself no longer crashes either', async () => {
  const res = await get('/api/bare');
  assert.equal(res.status, 500);
  await settle();
  assert.deepEqual(escaped, []);
});

test('catchAsyncHandlers is idempotent', () => {
  assert.equal(catchAsyncHandlers(), true);
  assert.equal(catchAsyncHandlers(), true);
});
