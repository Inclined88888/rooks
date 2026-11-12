/**
 * TODO #631: a mission whose timeline retention removed explains itself instead
 * of looking empty, and its button brings the timeline back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';

const MISSION = 'mission-old';
const SPAN = {
  id: 's1', mission_id: MISSION, trace_id: MISSION, parent_span_id: null, workflow_run_id: null, workflow_node_id: null,
  seq: 1, kind: 'tool', name: 'Read', status: 'ok', started_at: 1, ended_at: 2, duration_ms: 1,
  tokens_in: null, tokens_out: null, cost_usd: null, event_id_start: null, event_id_end: null, cursor: '1.1',
};

async function setup(options: { rebuildOk?: boolean; pruned: number }) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => { Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  let spans: typeof SPAN[] = [];
  let pruned = options.pruned;
  const posts: string[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(input);
      if (options.rebuildOk === false) return new Response(null, { status: 409 });
      spans = [SPAN]; pruned = 0;
      return Response.json({ missions: 1, events: 2, spans: 1 });
    }
    return Response.json({ mission_id: MISSION, spans, total: spans.length, has_more: false, pruned });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { MissionSpansTimeline } = await import('../plugins-client/workflows/mission-spans-timeline');
  (await import('../plugins-client/workflows/mission-spans')).clearSpanCache();
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(MissionSpansTimeline, { missionId: MISSION, live: false, filterable: false })); });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const notice = () => document.querySelector('[data-testid="trace-pruned"]');
  const click = async () => { await React.act(async () => { notice()!.querySelector('button')!.click(); }); };
  const dispose = async () => { await React.act(async () => { root.unmount(); }); };
  return { posts, until, notice, click, dispose };
}

test('a removed timeline says so, and the button rebuilds then shows it', async () => {
  const r = await setup({ pruned: 12 });
  try {
    await r.until(() => !!r.notice(), 'the notice');
    assert.match(r.notice()!.textContent ?? '', /12 spans/);
    await r.click();
    await r.until(() => !r.notice(), 'the timeline to come back');
    assert.deepEqual(r.posts, [`/api/ui/missions/${MISSION}/spans/rebuild`]);
    assert.ok(document.querySelector('ol > li'), 'the rebuilt span is on screen');
  } finally {
    await r.dispose();
  }
});

test('a refused rebuild leaves the notice in place', async () => {
  const r = await setup({ pruned: 3, rebuildOk: false });
  try {
    await r.until(() => !!r.notice(), 'the notice');
    await r.click();
    await r.until(() => r.posts.length === 1, 'the request');
    assert.ok(r.notice());
  } finally {
    await r.dispose();
  }
});

test('a mission with no span and nothing removed keeps the ordinary empty state', async () => {
  const r = await setup({ pruned: 0 });
  try {
    await r.until(() => !document.body.textContent?.includes('Loading'), 'the page to load');
    assert.equal(r.notice(), null);
  } finally {
    await r.dispose();
  }
});
