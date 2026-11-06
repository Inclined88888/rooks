/**
 * #215 — the trace card of a mission with a huge number of spans, mounted in
 * jsdom against a fake daemon of 20 000 spans. The assertions count what the
 * card holds and asks for (rows in the DOM, requests, their shape), never how
 * long it takes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TOTAL = 20_000;
const MISSION = 'm-big';

type FakeSpan = { id: string; trace_id: string; mission_id: string; parent_span_id: null; workflow_run_id: null; workflow_node_id: null; seq: number; kind: string; name: string; status: string; started_at: number; ended_at: number | null; duration_ms: number | null; tokens_in: null; tokens_out: null; cost_usd: null; cursor: string };

function makeSpan(i: number, status = 'ok'): FakeSpan {
  const seq = Math.ceil(i / 2);
  return { id: `s${i}`, trace_id: 't', mission_id: MISSION, parent_span_id: null, workflow_run_id: null, workflow_node_id: null, seq, kind: 'tool', name: 'Bash', status, started_at: i, ended_at: status === 'running' ? null : i + 1, duration_ms: status === 'running' ? null : 1, tokens_in: null, tokens_out: null, cost_usd: null, cursor: `${seq}.${i}` };
}

function cmp(a: string, b: string): number {
  const [as = 0, ar = 0] = a.split('.').map(Number);
  const [bs = 0, br = 0] = b.split('.').map(Number);
  return as - bs || ar - br;
}

async function setup() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => { Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);

  // The daemon: the same window semantics as GET /api/missions/:id/spans.
  const server: FakeSpan[] = Array.from({ length: TOTAL }, (_, i) => makeSpan(i + 1, i + 1 === TOTAL ? 'running' : 'ok'));
  const requests: string[] = [];
  install('fetch', async (input: string) => {
    requests.push(input);
    const url = new URL(input, 'http://localhost');
    const limit = Number(url.searchParams.get('limit') ?? 200);
    const before = url.searchParams.get('before');
    const from = url.searchParams.get('from');
    const ids = url.searchParams.get('ids');
    let spans: FakeSpan[]; let has_more = false;
    if (ids) spans = server.filter((span) => ids.split(',').includes(span.id));
    else if (from) { const rest = server.filter((span) => cmp(span.cursor, from) >= 0); has_more = rest.length > limit; spans = rest.slice(0, limit); }
    else { const older = before ? server.filter((span) => cmp(span.cursor, before) < 0) : server; has_more = older.length > limit; spans = older.slice(-limit); }
    return { ok: true, json: async () => ({ mission_id: MISSION, spans, total: server.length, has_more }) };
  });

  // The SSE stream the card listens to.
  const handlers = new Set<(event: { data: string }) => void>();
  class FakeEventSource {
    static CLOSED = 2;
    readyState = 1;
    addEventListener(type: string, fn: (event: { data: string }) => void) { if (type === 'event') handlers.add(fn); }
    removeEventListener(type: string, fn: (event: { data: string }) => void) { if (type === 'event') handlers.delete(fn); }
    close() { this.readyState = 2; }
  }
  install('EventSource', FakeEventSource);

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { MissionSpansTimeline } = await import('../plugins-client/workflows/mission-spans-timeline');
  (await import('../plugins-client/workflows/mission-spans')).clearSpanCache();
  const root = createRoot(document.getElementById('root')!);
  const mount = () => React.act(async () => { root.render(React.createElement(MissionSpansTimeline, { missionId: MISSION, live: true, filterable: false })); });
  const unmount = () => React.act(async () => { root.render(React.createElement('div')); });
  const rows = () => document.querySelectorAll('ol > li').length;
  const running = () => document.querySelectorAll('ol > li .animate-pulse').length;
  const click = (el: Element) => React.act(async () => { (el as HTMLElement).click(); });
  const emit = () => React.act(async () => {
    for (const fn of [...handlers]) fn({ data: JSON.stringify({ missionId: MISSION }) });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  });
  return { server, requests, mount, unmount, rows, running, click, emit, dispose: async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); } };
}

test('a huge mission loads one page, pages on request, and reopens from memory with a delta only', async () => {
  const r = await setup();
  try {
    await r.mount();
    assert.equal(r.rows(), 100, 'one page in the DOM, not 20 000 rows');
    assert.deepEqual(r.requests, [`/api/ui/missions/${MISSION}/spans?limit=100`], 'one request, no payload asked for');
    assert.equal(r.running(), 1, 'the last span is still running');

    const more = document.querySelector('[data-testid="trace-load-older"]')!;
    assert.match(more.textContent ?? '', /19900/, 'says how many are left');
    await r.click(more);
    assert.equal(r.rows(), 200);
    assert.match(r.requests.at(-1)!, /before=/);

    // Leave the card and come back (a chat switch, a layout change): no reload.
    await r.unmount();
    assert.equal(r.rows(), 0);
    r.requests.length = 0;
    await r.mount();
    assert.equal(r.rows(), 200, 'the loaded window is back at once');
    assert.ok(r.requests.length >= 1 && r.requests.length <= 2, `delta only, got ${r.requests.length} requests`);
    assert.ok(r.requests.every((url) => /[?&](from|ids)=/.test(url)), `no full reload: ${r.requests.join(' | ')}`);
  } finally {
    await r.dispose();
  }
});

test('an event brings only the new spans, and a span that was running is re-read when it closes', async () => {
  const r = await setup();
  try {
    await r.mount();
    const before = r.rows();
    r.server[TOTAL - 1] = makeSpan(TOTAL, 'ok');
    for (let i = TOTAL + 1; i <= TOTAL + 3; i += 1) r.server.push(makeSpan(i));
    r.requests.length = 0;
    await r.emit();
    assert.equal(r.rows(), before + 3, 'three new rows, the rest untouched');
    assert.equal(r.running(), 0, 'the span that closed no longer pulses');
    assert.ok(r.requests.every((url) => /[?&](from|ids)=/.test(url)), r.requests.join(' | '));
    assert.ok(r.requests.length <= 2);
  } finally {
    await r.dispose();
  }
});
