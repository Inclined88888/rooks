/**
 * TODO #547 — a workflow run's spans arrive without payloads: the opened span
 * reads them from the run's route (`payload_url`), not from the mission's,
 * which the viewer of a run may not be allowed to read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('an opened span without payload fetches it from its payload_url, then shows it', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/workflows/x/runs/r', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => { Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  // next/link reads `self` (the window) while it renders.
  install('self', dom.window);
  const requests: string[] = [];
  install('fetch', async (input: string) => {
    requests.push(input);
    return { ok: true, json: async () => ({ span: { input: '{"path":"/srv/run-payload"}', output: null, error: null } }) };
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SpanDetail } = await import('./trace-panel');
  const root = createRoot(document.getElementById('root')!);
  const span = {
    id: 'tool:1', trace_id: 'r', mission_id: 'system', parent_span_id: null, workflow_run_id: 'r', workflow_node_id: 'n1',
    seq: 1, kind: 'tool', name: 'Read', status: 'ok', started_at: 1, ended_at: 2, duration_ms: 1,
    tokens_in: null, tokens_out: null, cost_usd: null, payload_url: '/api/ui/workflows/runs/r/spans/tool%3A1',
  };
  try {
    await React.act(async () => { root.render(React.createElement(SpanDetail, { span, onClose: () => {} })); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(requests, ['/api/ui/workflows/runs/r/spans/tool%3A1']);
    assert.match(document.body.textContent ?? '', /\/srv\/run-payload/);
  } finally {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
  }
});
