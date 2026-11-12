import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
/** Layout rows the local daemon serves on `/api/layout?scope=`. */
const rows = new Map<string, unknown>();
/** Every method the local daemon received. */
const methods: string[] = [];
const ok: Handler = (req, res) => {
  methods.push(req.method ?? 'GET');
  res.writeHead(200, { 'content-type': 'application/json' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/layout') {
    res.end(JSON.stringify({ layout: rows.get(url.searchParams.get('scope') ?? '') ?? null }));
    return;
  }
  res.end('{"ok":true}');
};

function daemon(handler: Handler): { server: Server; seen: string[] } {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? '');
    handler(req, res);
  });
  return { server, seen };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const local = daemon(ok);
// Accepts the request and never answers: only the caller's budget ends it.
const silent = daemon(() => {});
let localUrl = '';
let silentUrl = '';
let fetchForRender!: typeof import('./server-workspace').fetchForRender;
let resolveLayoutSeeds!: typeof import('./server-workspace').resolveLayoutSeeds;

test.before(async () => {
  localUrl = await listen(local.server);
  silentUrl = await listen(silent.server);
  // `paths.ts` reads the daemon's address once, at import.
  process.env.ORCHESTRATOR_URL = localUrl;
  ({ fetchForRender, resolveLayoutSeeds } = await import('./server-workspace'));
});

test.after(() => {
  for (const { server } of [local, silent]) {
    server.closeAllConnections();
    server.close();
  }
});

test('outside a request, a render read goes to the local daemon', async () => {
  const res = await fetchForRender('/api/layout?scope=x');
  assert.equal(res.status, 200);
  assert.deepEqual(local.seen.slice(-1), ['/api/layout?scope=x']);
});

test('a pinned target is read instead of the active machine', async () => {
  const before = local.seen.length;
  // A budget the silent daemon outlives on a loaded machine: at 50 ms the read
  // was sometimes aborted before the request reached it, and `seen` stayed empty.
  await assert.rejects(
    fetchForRender('/api/auth/me', { kind: 'local', id: 'local', url: silentUrl, timeoutMs: 1_000 }),
  );
  assert.equal(local.seen.length, before);
  assert.deepEqual(silent.seen.slice(-1), ['/api/auth/me']);
});

test('the budget of a render read is the target\'s', async () => {
  const started = Date.now();
  await assert.rejects(
    fetchForRender('/api/license', { kind: 'local', id: 'local', url: silentUrl, timeoutMs: 50 }),
    (err: Error) => err.name === 'TimeoutError',
  );
  assert.ok(Date.now() - started < 1_500, 'the 50 ms budget, not a fixed one, ended the read');
});

// TODO #790: on a remote machine, a view's rows and its rail still sit under
// the keys hashed with the local id until the browser's first read moves them.
// The server paints them meanwhile, and only reads.
test('the first paint is seeded from the rows held under the previous keys, read only', async () => {
  rows.clear();
  rows.set('v2.old.widgets', { cards: ['git'] });
  rows.set('cockpit', { cards: ['stock'] });
  rows.set('chat.columns', { left: 300 });
  rows.set('old-nav', { pinned: true });
  methods.length = 0;
  const seeds = await resolveLayoutSeeds(
    { route: 'r', key: 'v2.new', sharedKey: 'v2.new.shared-presets', previousKey: 'v2.old', owner: 'remote', project: null, view: '/' },
    [{ scope: 'new-nav', legacy: [{ scope: 'old-nav', consumed: true }] }],
  );
  assert.deepEqual(seeds['v2.new.widgets'], { cards: ['git'] }, 'the previous row wins over the shared one');
  assert.deepEqual(seeds['v2.new.columns'], { left: 300 }, 'no previous row: the shared one');
  assert.deepEqual(seeds['new-nav'], { pinned: true });
  assert.ok(methods.length > 0 && methods.every((method) => method === 'GET'), 'reads only');
  rows.clear();
});
