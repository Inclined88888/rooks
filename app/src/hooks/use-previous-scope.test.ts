import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * TODO #790: an account-wide row (the rail, the strip, the pinned popups) is
 * read only once the scope it hands over from is known. Read before, its first
 * read would find it empty, mark it as read, and never take the old row.
 */
test('an account row waits for its previous scope, then takes the old row', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = globalThis as Record<string, unknown>;
  const previous = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const stored = new Map<string, unknown>([['strip:local-id', { pinned: ['alpha'] }]]);
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const scope = new URL(String(input), 'http://localhost').searchParams.get('scope')!;
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${scope}`);
    if (method === 'PUT') stored.set(scope, JSON.parse(String(init?.body)).layout);
    if (method === 'DELETE') stored.delete(scope);
    return Response.json(method === 'GET' ? { layout: stored.get(scope) ?? null } : { ok: true });
  }) as typeof globalThis.fetch;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { usePreviousScope } = await import('./use-previous-scope');
  const { useStoredLayout } = await import('./use-stored-layout');
  const { rowHandover } = await import('../lib/layout-handover');
  const derive = async (owner: string) => `strip:${owner}`;
  const root = createRoot(document.getElementById('root')!);
  let raw: unknown;
  let previousSeen: Array<string | null | undefined> = [];
  function Strip({ owner, previousOwner }: { owner: string; previousOwner: string | null }) {
    const previousScope = usePreviousScope(previousOwner, derive);
    previousSeen.push(previousScope);
    raw = useStoredLayout(previousScope === undefined ? null : `strip:${owner}`, rowHandover(previousScope)).raw;
    return null;
  }
  try {
    await React.act(async () => { root.render(React.createElement(Strip, { owner: 'remote-id', previousOwner: 'local-id' })); });
    await React.act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    assert.equal(previousSeen[0], undefined, 'unknown on the first render');
    assert.deepEqual(raw, { pinned: ['alpha'] });
    assert.deepEqual(requests, ['GET strip:remote-id', 'GET strip:local-id', 'PUT strip:remote-id', 'DELETE strip:local-id']);

    // On this computer, nothing to wait for.
    previousSeen = [];
    await React.act(async () => { root.render(React.createElement(Strip, { owner: 'local-only', previousOwner: null })); });
    assert.equal(previousSeen[0], null);
  } finally {
    await React.act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
    dom.window.close();
  }
});
