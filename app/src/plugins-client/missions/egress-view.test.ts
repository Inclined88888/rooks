/**
 * The mission's Network view (TODO #590, T4): what the journal holds is
 * painted with the new hosts marked, an empty journal explains what it cannot
 * see, a disabled proxy is said, a refusal is a sentence rather than a blank,
 * and older pages are read with the daemon's cursor.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EgressConnection, MissionEgress } from '@/lib/egress';
import { waitUntil } from '@/lib/test-wait';

const NOW = Date.now();

function connection(id: number, over: Partial<EgressConnection> = {}): EgressConnection {
  return { id, method: 'CONNECT', host: 'api.example.com', port: 443, status: 200, bytes_out: 1200, bytes_in: 48_000, started_at: NOW - id * 1000, duration_ms: 320, error: null, ...over };
}

function journal(over: Partial<MissionEgress> = {}): MissionEgress {
  return {
    mission_id: 'm-1',
    connections: [connection(3), connection(2, { host: 'fresh.example', status: 502, error: 'ECONNREFUSED' }), connection(1, { method: 'GET', port: 80 })],
    has_more: false,
    next_before: null,
    hosts: [
      { host: 'api.example.com', connections: 2, bytes_out: 2400, bytes_in: 96_000, first_at: NOW - 3000, last_at: NOW - 1000, failures: 0 },
      { host: 'fresh.example', connections: 1, bytes_out: 0, bytes_in: 0, first_at: NOW - 2000, last_at: NOW - 2000, failures: 1 },
    ],
    new_hosts: [{ host: 'fresh.example', first_seen_at: NOW - 2000 }],
    retention: { per_mission: 2000, max_age_ms: 30 * 86_400_000 },
    proxy: { mode: 'log', listening: true },
    ...over,
  };
}

test('the Network view paints the journal, its states and its pages', async (suite) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { EgressView } = await import('./egress-view');
  const originalFetch = globalThis.fetch;

  let answer: () => Response = () => Response.json(journal());
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (!url.startsWith('/api/ui/missions/')) throw new Error(`unexpected fetch ${url}`);
    return answer();
  };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const text = () => document.getElementById('root')!.textContent ?? '';
  let root = createRoot(document.getElementById('root')!);
  const mount = async (missionId = 'm-1') => {
    await React.act(async () => root.unmount());
    root = createRoot(document.getElementById('root')!);
    urls.length = 0;
    await React.act(async () => root.render(React.createElement(EgressView, { missionId })));
  };

  try {
    await suite.test('hosts and connections are painted, the new host marked and listed first', async () => {
      await mount();
      await until(() => !!document.querySelector('[data-egress-host]'), 'the hosts');
      assert.equal(urls[0], '/api/ui/missions/m-1/egress?limit=100');
      const hosts = Array.from(document.querySelectorAll<HTMLElement>('[data-egress-host]'));
      assert.deepEqual(hosts.map((el) => [el.dataset.egressHost, el.dataset.new ?? null]), [['fresh.example', 'true'], ['api.example.com', null]]);
      assert.match(hosts[0]!.textContent!, /new/);
      assert.match(hosts[0]!.textContent!, /1 failed/);
      assert.equal(document.querySelectorAll('[data-egress-connection]').length, 3);
      assert.match(text(), /fresh\.example:443/);
      assert.match(text(), /Upstream error: ECONNREFUSED/);
      assert.match(text(), /320 ms/);
      assert.match(text(), /47 KB/);
      assert.match(text(), /last 2000 connections of the mission, 30 days at most/);
      assert.ok(!document.querySelector('[data-egress-proxy]'), 'a listening proxy is not mentioned');
      assert.ok(!text().includes('Load older'), 'no older page to offer');
    });

    await suite.test('an empty journal says what the journal cannot see', async () => {
      answer = () => Response.json(journal({ connections: [], hosts: [], new_hosts: [] }));
      await mount();
      await until(() => !!document.querySelector('[data-egress-empty]'), 'the empty state');
      assert.match(text(), /No connection journaled for this mission yet/);
      assert.match(text(), /HTTP\(S\)_PROXY/);
      assert.match(text(), /Node's built-in fetch/);
    });

    await suite.test('a proxy turned off says the journal is disabled and how to enable it, never an empty list', async () => {
      answer = () => Response.json(journal({ connections: [], hosts: [], new_hosts: [], proxy: { mode: 'off', listening: false } }));
      await mount();
      await until(() => !!document.querySelector('[data-egress-proxy="off"]'), 'the off notice');
      assert.match(text(), /Connection journal disabled/);
      assert.match(text(), /host\.isolation\.egress\.mode to "log" in timon\.config\.json/);
      assert.ok(!document.querySelector('[data-egress-empty]'), 'no empty state');
      assert.ok(!text().includes('No connection journaled'), 'nothing that reads as "reached nothing"');
      assert.ok(!text().includes('0 conn.'), 'no zero count');
      assert.ok(!text().includes('before it was turned off'), 'no history to speak of');
    });

    await suite.test('a proxy turned off keeps the connections recorded before, and says when they date from', async () => {
      answer = () => Response.json(journal({ proxy: { mode: 'off', listening: false } }));
      await mount();
      await until(() => !!document.querySelector('[data-egress-connection]'), 'the kept connections');
      assert.ok(document.querySelector('[data-egress-proxy="off"]'), 'the off notice');
      assert.match(text(), /before it was turned off/);
      assert.equal(document.querySelectorAll('[data-egress-connection]').length, 3);
    });

    await suite.test('a proxy that should run but does not is said above the journal', async () => {
      answer = () => Response.json(journal({ proxy: { mode: 'log', listening: false } }));
      await mount();
      await until(() => !!document.querySelector('[data-egress-proxy="down"]'), 'the not-running notice');
    });

    await suite.test('an anonymous or absent answer is a sentence, not a blank', async () => {
      answer = () => Response.json({ error: 'unauthorized' }, { status: 401 });
      await mount();
      await until(() => !!document.querySelector('[data-egress-failure]'), 'the 401 notice');
      assert.equal(document.querySelector<HTMLElement>('[data-egress-failure]')!.dataset.egressFailure, 'unauthorized');
      assert.match(text(), /Sign in again/);
      answer = () => Response.json({ error: 'mission not found' }, { status: 404 });
      await mount('gone');
      await until(() => document.querySelector<HTMLElement>('[data-egress-failure]')?.dataset.egressFailure === 'not_found', 'the 404 notice');
      assert.match(text(), /does not exist, or it belongs to another account/);
      assert.ok(!document.querySelector('[data-egress-connection]'));
    });

    await suite.test('older connections are read with the cursor and appended', async () => {
      let page = 0;
      answer = () => {
        page += 1;
        return page === 1
          ? Response.json(journal({ connections: [connection(9), connection(8)], has_more: true, next_before: 8 }))
          : Response.json(journal({ connections: [connection(7), connection(6)], has_more: false, next_before: null }));
      };
      await mount();
      await until(() => text().includes('Load older'), 'the older button');
      const older = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Load older'))!;
      await React.act(async () => { older.click(); });
      await until(() => document.querySelectorAll('[data-egress-connection]').length === 4, 'the older page');
      assert.equal(urls.at(-1), '/api/ui/missions/m-1/egress?limit=100&before=8');
      assert.deepEqual(Array.from(document.querySelectorAll<HTMLElement>('[data-egress-connection]')).map((el) => el.dataset.egressConnection), ['9', '8', '7', '6']);
      assert.ok(!text().includes('Load older'));
    });
  } finally {
    await React.act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    setLocale(previousLocale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('the island content takes a mission id and nothing else', async () => {
  const { parseEgressIslandParams, egressIslandContent, EGRESS_ISLAND_TYPE } = await import('@/lib/egress');
  assert.deepEqual(parseEgressIslandParams({ missionId: 'abc-123', extra: 1 }), { missionId: 'abc-123' });
  assert.equal(parseEgressIslandParams({}), null);
  assert.equal(parseEgressIslandParams({ missionId: '../etc' }), null);
  assert.equal(parseEgressIslandParams({ missionId: 'a'.repeat(129) }), null);
  assert.equal(parseEgressIslandParams(null), null);
  assert.deepEqual(egressIslandContent('m-1'), { type: EGRESS_ISLAND_TYPE, params: { missionId: 'm-1' } });
  assert.equal(EGRESS_ISLAND_TYPE, '@timon/missions:egress');
});

test('hosts: new first, then the most recent; failures and durations read as the journal counts them', async () => {
  const { orderHosts, connectionFailed, formatDuration, egressFailure } = await import('@/lib/egress');
  const host = (name: string, last: number) => ({ host: name, connections: 1, bytes_out: 0, bytes_in: 0, first_at: 0, last_at: last, failures: 0 });
  assert.deepEqual(orderHosts([host('a', 5), host('b', 9), host('c', 1)], new Set(['c'])).map((h) => h.host), ['c', 'b', 'a']);
  assert.equal(connectionFailed({ status: 200, error: null }), false);
  assert.equal(connectionFailed({ status: 404, error: null }), true);
  assert.equal(connectionFailed({ status: 200, error: 'ECONNRESET' }), true);
  assert.equal(formatDuration(42), '42 ms');
  assert.equal(formatDuration(3_400), '3.4 s');
  assert.equal(formatDuration(125_000), '2m05');
  assert.deepEqual([401, 403, 404, 500].map(egressFailure), ['unauthorized', 'forbidden', 'not_found', 'unavailable']);
});

test('the missions module registers the card and the island content, its params held to its parser', async () => {
  const slots = await import('@/lib/plugin-host/slots');
  const { coreMissionsClient } = await import('../missions');
  slots.resetSlotsForTests();
  const seen: Array<{ slot: string; key?: string; island?: { params?: Record<string, { required?: boolean; maxLength?: number }>; parseParams: (raw: unknown) => unknown; singletonBy?: unknown } }> = [];
  coreMissionsClient.apply({
    id: coreMissionsClient.module,
    realtime: {} as never,
    caps: null,
    zoneVisible: () => true,
    options: {},
    register: (options) => { seen.push(options as (typeof seen)[number]); return () => {}; },
    onDispose: () => {},
  });
  assert.ok(seen.some((o) => o.slot === 'cockpit.widget' && o.key === 'egress'), 'the rail card');
  const island = seen.find((o) => o.slot === 'island.content' && o.key === 'egress')?.island;
  assert.ok(island, 'the island content');
  assert.deepEqual(Object.keys(island.params ?? {}), ['missionId']);
  assert.equal(island.params?.missionId?.required, true);
  assert.equal(island.params?.missionId?.maxLength, 128);
  assert.equal(island.singletonBy, 'missionId');
  assert.ok(island.parseParams({ missionId: 'm-1' }));
});
