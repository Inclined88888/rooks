/**
 * The tab's single backend catalogue (TODO #52, volet 2).
 *
 * Every selector on screen follows the same store: one invalidation must give
 * one request, not one per mounted selector. And the catalogue carries the
 * account instances of the SIGNED-IN user: a response that left before
 * another user signed in must never become the cache.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announceAccount } from './account-change';
import {
  invalidateBackendCatalog,
  refreshBackendCatalog,
  refreshBackendCatalogIfStale,
  subscribeBackendCatalog,
  type BackendCatalog,
} from './backends';

type Pending = { resolve: (body: BackendCatalog) => void };

/** A `fetch` held by hand: each call waits until the test answers it. */
function holdFetch(): { calls: Pending[]; restore: () => void } {
  const calls: Pending[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>((done) => {
    calls.push({ resolve: (body) => done(new Response(JSON.stringify(body), { status: 200 })) });
  })) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const catalogOf = (...ids: string[]): BackendCatalog => ({
  defaultBackend: 'claude',
  backends: ids.map((id) => ({ id, label: id, defaultModel: null, models: [] })),
});

const settle = () => new Promise((done) => setTimeout(done, 0));

test('one refresh feeds every selector with a single request', async () => {
  invalidateBackendCatalog();
  const held = holdFetch();
  try {
    const seen: string[][] = [[], [], []];
    const stops = seen.map((list) => subscribeBackendCatalog((cat) => list.push(cat.backends.map((b) => b.id).join(','))));
    refreshBackendCatalog();
    refreshBackendCatalog();
    // The second refresh drops the first request: only the latest counts.
    assert.equal(held.calls.length, 2);
    held.calls[1]?.resolve(catalogOf('claude', 'claude@a1'));
    await settle();
    held.calls[0]?.resolve(catalogOf('stale'));
    await settle();
    assert.deepEqual(seen, [['claude,claude@a1'], ['claude,claude@a1'], ['claude,claude@a1']]);
    for (const stop of stops) stop();
  } finally {
    held.restore();
  }
});

test('a response sent for the previous user never becomes the cache', async () => {
  invalidateBackendCatalog();
  const held = holdFetch();
  try {
    const seen: string[] = [];
    const stop = subscribeBackendCatalog((cat) => seen.push(cat.backends.map((b) => b.id).join(',')));
    refreshBackendCatalog();
    assert.equal(held.calls.length, 1);
    // Bob signs in while Alice's catalogue is on its way.
    announceAccount('bob');
    assert.equal(held.calls.length, 2);
    held.calls[0]?.resolve(catalogOf('claude', 'claude@alice'));
    await settle();
    assert.deepEqual(seen, []);
    held.calls[1]?.resolve(catalogOf('claude', 'claude@bob'));
    await settle();
    assert.deepEqual(seen, ['claude,claude@bob']);
    stop();
  } finally {
    held.restore();
  }
});

test('a fresh catalogue is not read again; an old one is', async () => {
  invalidateBackendCatalog();
  const held = holdFetch();
  try {
    const stop = subscribeBackendCatalog(() => {});
    refreshBackendCatalog();
    held.calls[0]?.resolve(catalogOf('claude'));
    await settle();
    refreshBackendCatalogIfStale(Date.now() + 1_000);
    assert.equal(held.calls.length, 1);
    refreshBackendCatalogIfStale(Date.now() + 31_000);
    assert.equal(held.calls.length, 2);
    held.calls[1]?.resolve(catalogOf('claude'));
    await settle();
    stop();
  } finally {
    held.restore();
  }
});

test('a target has its own read, and the inventory never stands in for it', async () => {
  invalidateBackendCatalog();
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string) => {
    urls.push(String(input));
    const targeted = String(input).includes('?');
    return Promise.resolve(Response.json(catalogOf(...(targeted ? ['claude'] : ['claude', 'opencode']))));
  }) as typeof fetch;
  try {
    const inventory: string[] = [];
    const scoped: string[] = [];
    const elsewhere: string[] = [];
    const stops = [
      subscribeBackendCatalog((cat) => inventory.push(cat.backends.map((b) => b.id).join(','))),
      subscribeBackendCatalog((cat) => scoped.push(cat.backends.map((b) => b.id).join(',')), { project: 'alpha', agent: 'alpha.coder' }),
      subscribeBackendCatalog((cat) => elsewhere.push(cat.backends.map((b) => b.id).join(',')), { project: 'alpha', agent: 'alpha.coder' }),
    ];
    refreshBackendCatalog();
    await settle();
    await settle();
    assert.deepEqual(urls.sort(), [
      '/api/ui/backends/catalog',
      '/api/ui/backends/catalog?project=alpha&agent=alpha.coder',
    ], 'one request per target, whatever the number of selectors on it');
    assert.deepEqual(inventory, ['claude,opencode']);
    assert.deepEqual(scoped, ['claude'], 'the reserved backend does not reach a picker of this target');
    assert.deepEqual(elsewhere, ['claude']);
    for (const stop of stops) stop();
  } finally {
    globalThis.fetch = original;
  }
});

test('catalogTargetQuery sends the two parameters and nothing else', async () => {
  const { catalogTargetQuery } = await import('./catalog-target');
  assert.equal(catalogTargetQuery(null), '');
  assert.equal(catalogTargetQuery({ project: '  ', agent: null }), '', 'an empty target is the inventory, not an empty filter');
  assert.equal(catalogTargetQuery({ project: 'a b', agent: 'x&admin=1' }), 'project=a+b&agent=x%26admin%3D1');
  const smuggled = { project: 'alpha', viewer: 'someone' } as { project: string };
  assert.equal(catalogTargetQuery(smuggled), 'project=alpha');
});

test('a stale target nobody reads is forgotten without a request', async () => {
  invalidateBackendCatalog();
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string) => {
    urls.push(String(input));
    return Promise.resolve(Response.json(catalogOf('claude')));
  }) as typeof fetch;
  try {
    const stop = subscribeBackendCatalog(() => {}, { project: 'alpha' });
    refreshBackendCatalog();
    await settle();
    await settle();
    stop();
    urls.length = 0;
    refreshBackendCatalogIfStale(Date.now() + 60_000);
    await settle();
    assert.deepEqual(urls, []);
  } finally {
    globalThis.fetch = original;
  }
});
