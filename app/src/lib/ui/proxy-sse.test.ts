import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;

// A stand-in for the daemon's stream: counts the requests it is still holding.
// `/slow` answers its headers late, `/fast` at once.
let open = 0;
const urls: string[] = [];
const timers = new Set<NodeJS.Timeout>();
const server = createServer((req: IncomingMessage, res) => {
  open += 1;
  urls.push(req.url ?? '');
  req.on('close', () => { open -= 1; });
  const answer = () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    res.write(': hello\n\n');
  };
  if (req.url?.startsWith('/slow')) {
    const t = setTimeout(answer, 300);
    timers.add(t);
    req.on('close', () => clearTimeout(t));
  } else answer();
});
let proxySse!: (path: string, req: Request) => Promise<Response>;
let sseClientQuery!: (req: Request) => string;

test.before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  // `paths.ts` reads the daemon's address once, at import.
  process.env.ORCHESTRATOR_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ({ proxySse, sseClientQuery } = await import('./proxy'));
});

test.after(() => {
  for (const t of timers) clearTimeout(t);
  server.closeAllConnections();
  server.close();
});

async function until(check: () => boolean, what: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`still holding after ${ms} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const stream = (signal?: AbortSignal) => new Request('http://app/api/ui/stream', signal ? { signal } : undefined);

test('a client that leaves while the daemon is still answering leaves no stream open', async () => {
  const gone = new AbortController();
  const pending = proxySse('/slow', stream(gone.signal));
  await until(() => open === 1, 'the daemon never saw the request');
  gone.abort();
  const res = await pending;
  assert.equal(res.body, null, 'nothing is relayed to a client that is gone');
  await until(() => open === 0, 'the upstream request outlived its client');
});

test('a client that leaves mid-stream without Next cancelling the body closes the upstream', async () => {
  const gone = new AbortController();
  const res = await proxySse('/fast', stream(gone.signal));
  assert.equal(res.status, 200);
  await until(() => open === 1, 'the daemon never saw the request');
  // Next returns early on a destroyed response and never touches the body.
  gone.abort();
  await until(() => open === 0, 'the upstream request outlived its client');
});

test('a consumer that cancels the body still closes the upstream', async () => {
  const res = await proxySse('/fast', stream());
  await until(() => open === 1, 'the daemon never saw the request');
  await res.body!.cancel();
  await until(() => open === 0, 'the upstream request outlived its consumer');
});

test('a request that is already aborted never reaches the daemon', async () => {
  const before = urls.length;
  const res = await proxySse('/fast', stream(AbortSignal.abort()));
  assert.equal(res.body, null);
  assert.equal(urls.length, before);
});

test('the stream carries the window id only when it is well formed', () => {
  const q = (url: string) => sseClientQuery(new Request(url));
  assert.equal(q('http://app/api/ui/stream?client=win-3f2a.chat'), '?client=win-3f2a.chat');
  assert.equal(q('http://app/api/ui/stream'), '');
  assert.equal(q('http://app/api/ui/stream?client='), '');
  assert.equal(q('http://app/api/ui/stream?client=a/b'), '');
  assert.equal(q('http://app/api/ui/stream?client=' + 'x'.repeat(65)), '');
});
