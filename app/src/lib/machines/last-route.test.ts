import assert from 'node:assert/strict';
import test from 'node:test';
import { landingRoute, lastRouteFor, rememberRoute, ROUTE_ID_RULES, safeRoute } from './last-route';
import { MACHINE_ATTRIBUTE } from './machine-storage';
import { LOCAL_MACHINE_ID } from './machine-id';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
  raw(): Record<string, string> { return Object.fromEntries(this.map); }
}

type Globals = { document?: unknown; window?: unknown };
const g = globalThis as Globals;

function inPage(machine: string | undefined, local = new MemoryStorage()): MemoryStorage {
  g.document = { documentElement: { getAttribute: (name: string) => (name === MACHINE_ATTRIBUTE ? machine ?? null : null) } };
  g.window = { localStorage: local, sessionStorage: new MemoryStorage() };
  return local;
}

test.afterEach(() => {
  delete g.document;
  delete g.window;
});

test('safeRoute keeps a same-origin path and its query', () => {
  assert.equal(safeRoute('/'), '/');
  assert.equal(safeRoute('/chat?agent=a&mission=m1'), '/chat?agent=a&mission=m1');
  assert.equal(safeRoute('/kanban#top'), '/kanban');
  assert.equal(safeRoute('/workflows/my-flow/runs/42'), '/workflows/my-flow/runs/42');
});

test('safeRoute refuses anything that could leave the origin', () => {
  for (const raw of [
    '', 'chat', 'https://evil.example/', 'javascript:alert(1)', '//evil.example/x', '/\\evil.example',
    '\\\\evil.example', '/\t/evil.example', '/\n/evil.example', ' /chat', '/chat x', `/${'a'.repeat(2048)}`,
  ]) {
    assert.equal(safeRoute(raw), null, JSON.stringify(raw));
  }
  assert.equal(safeRoute(null), null);
  assert.equal(safeRoute(42), null);
});

test('safeRoute drops pages that are not a place to land on, and the Settings overlay', () => {
  for (const raw of ['/login', '/login?next=/chat', '/setup', '/setup/agent', '/invite?token=x', '/confirm-email/abc', '/api/ui/agents', '/_next/static/x.js']) {
    assert.equal(safeRoute(raw), null, raw);
  }
  // Prefixes are whole segments: `/settings-like` is not `/setup`.
  assert.equal(safeRoute('/setupx'), '/setupx');
  assert.equal(safeRoute('/kanban?settings=plugins'), '/kanban');
  assert.equal(safeRoute('/chat?agent=a&settings=machines'), '/chat?agent=a');
});

test('a machine never visited lands on the home page', () => {
  inPage(undefined);
  assert.equal(lastRouteFor('vps'), '/');
  assert.equal(lastRouteFor(LOCAL_MACHINE_ID), '/');
});

test('outside a browser nothing is kept and the landing is the home page', () => {
  rememberRoute('/kanban', 'vps');
  assert.equal(lastRouteFor('vps'), '/');
});

test('each machine keeps its own last page, under its own prefix', () => {
  const local = inPage(undefined);
  rememberRoute('/kanban');
  inPage('vps', local);
  rememberRoute('/chat?agent=a&mission=m1');
  rememberRoute('/missions', 'nas');
  assert.equal(lastRouteFor(LOCAL_MACHINE_ID), '/kanban');
  assert.equal(lastRouteFor('vps'), '/chat?agent=a&mission=m1');
  assert.equal(lastRouteFor('nas'), '/missions');
  assert.deepEqual(local.raw(), {
    'rooks:last-route': '/kanban',
    'm:vps:rooks:last-route': '/chat?agent=a&mission=m1',
    'm:nas:rooks:last-route': '/missions',
  });
});

test('an unsafe route never replaces the last good one', () => {
  inPage('vps');
  rememberRoute('/kanban');
  rememberRoute('//evil.example');
  rememberRoute('/login');
  assert.equal(lastRouteFor('vps'), '/kanban');
});

test('a tampered stored value is refused on read', () => {
  const local = inPage(undefined);
  local.setItem('m:vps:rooks:last-route', 'https://evil.example/');
  local.setItem('rooks:last-route', '/\\evil.example');
  assert.equal(lastRouteFor('vps'), '/');
  assert.equal(lastRouteFor(LOCAL_MACHINE_ID), '/');
});

test('a blocked storage falls back to the home page', () => {
  const throwing = new MemoryStorage();
  throwing.getItem = () => { throw new Error('blocked'); };
  throwing.setItem = () => { throw new Error('quota'); };
  inPage('vps', throwing);
  assert.doesNotThrow(() => rememberRoute('/kanban'));
  assert.equal(lastRouteFor('vps'), '/');
});

type Answers = Record<string, number | 'throw'>;

function fakeFetch(answers: Answers) {
  const calls: string[] = [];
  const fetcher = async (path: string) => {
    calls.push(path);
    const answer = answers[path] ?? 200;
    if (answer === 'throw') throw new Error('network');
    return { status: answer };
  };
  return { calls, fetcher };
}

test('landingRoute keeps a page whose ids exist there', async () => {
  const { calls, fetcher } = fakeFetch({});
  assert.equal(await landingRoute('/chat?agent=a&mission=m1', fetcher), '/chat?agent=a&mission=m1');
  assert.deepEqual(calls.sort(), ['/api/ui/agents/a', '/api/ui/missions/m1?view=status']);
});

test('landingRoute sends a page naming a gone object to its section root', async () => {
  const cases: Array<[string, Answers, string]> = [
    ['/chat?agent=a&mission=gone', { '/api/ui/missions/gone?view=status': 404 }, '/chat'],
    ['/chat?agent=gone', { '/api/ui/agents/gone': 404 }, '/chat'],
    ['/chat?task=gone', { '/api/ui/tasks/gone': 404 }, '/chat'],
    ['/missions?selected=gone', { '/api/ui/missions/gone?view=status': 404 }, '/missions'],
    ['/edit?agent=gone', { '/api/ui/agents/gone': 404 }, '/agents'],
  ];
  for (const [route, answers, expected] of cases) {
    const { fetcher } = fakeFetch(answers);
    assert.equal(await landingRoute(route, fetcher), expected, route);
  }
});

test('landingRoute keeps the page unless the machine says 404', async () => {
  for (const answer of [401, 403, 500, 502, 'throw'] as const) {
    const { fetcher } = fakeFetch({ '/api/ui/missions/m1?view=status': answer });
    assert.equal(await landingRoute('/missions?selected=m1', fetcher), '/missions?selected=m1', String(answer));
  }
});

test('landingRoute does not probe a page that names nothing', async () => {
  const { calls, fetcher } = fakeFetch({});
  assert.equal(await landingRoute('/kanban', fetcher), '/kanban');
  assert.equal(await landingRoute('/chat', fetcher), '/chat');
  assert.deepEqual(calls, []);
});

test('landingRoute encodes the id it probes, and refuses an unsafe route', async () => {
  const { calls, fetcher } = fakeFetch({});
  await landingRoute('/edit?agent=a%2F..%2Fb', fetcher);
  assert.deepEqual(calls, ['/api/ui/agents/a%2F..%2Fb']);
  assert.equal(await landingRoute('//evil.example', fetcher), '/');
});

test('landingRoute gives up on a slow probe and keeps the page', async () => {
  // A 404 that would come far too late; its timer also keeps Node's event
  // loop alive, which the unref'd `AbortSignal.timeout` does not.
  const fetcher = (_path: string, init: RequestInit) => new Promise<{ status: number }>((resolve, reject) => {
    const late = setTimeout(() => resolve({ status: 404 }), 5_000);
    init.signal?.addEventListener('abort', () => { clearTimeout(late); reject(new Error('aborted')); });
  });
  assert.equal(await landingRoute('/missions?selected=m1', fetcher, ROUTE_ID_RULES, 20), '/missions?selected=m1');
});

test('a pattern rule reads its id from the path', async () => {
  const rules = [{ pathname: /^\/trace\/[^/]+$/, id: (url: URL) => url.pathname.split('/')[2] ?? null, probe: (id: string) => `/api/ui/trace/${id}`, fallback: '/activity' }];
  const { fetcher } = fakeFetch({ '/api/ui/trace/t1': 404 });
  assert.equal(await landingRoute('/trace/t1', fetcher, rules), '/activity');
  assert.equal(await landingRoute('/trace/t2', fetcher, rules), '/trace/t2');
});
