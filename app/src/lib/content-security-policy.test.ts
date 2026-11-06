import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CSP_HEADER,
  MAX_EGRESS_HOSTS,
  contentSecurityPolicy,
  createEgressSource,
  enforceContentSecurityPolicy,
  pageEgressHosts,
  wantsFreshPolicy,
} from './content-security-policy';
import { createWindowPolicy } from './ui/window-csp';

function directive(policy: string, name: string): string[] {
  const found = policy.split(';').map((d) => d.trim().split(/\s+/)).find(([key]) => key === name);
  assert.ok(found, `${name} missing from ${policy}`);
  return found.slice(1);
}

function dictationPlugin(id: string, engines: unknown[], over: Record<string, unknown> = {}) {
  return {
    id,
    state: 'active',
    client: { url: `/api/plugins/${id}/client.js`, rev: '1', slots: ['dictation.engine'] },
    dictation: { engines, models: null },
    ...over,
  };
}

test('without a declared host, the window reaches its own origin and nothing else', () => {
  const policy = contentSecurityPolicy({ egressHosts: [], dev: false });
  assert.deepEqual(directive(policy, 'connect-src'), ["'self'", 'data:', 'blob:']);
  assert.deepEqual(directive(policy, 'default-src'), ["'self'"]);
  // Every other way to send bytes out is held to the origin too.
  assert.deepEqual(directive(policy, 'img-src'), ["'self'", 'data:', 'blob:']);
  assert.deepEqual(directive(policy, 'media-src'), ["'self'", 'data:', 'blob:']);
  assert.deepEqual(directive(policy, 'font-src'), ["'self'", 'data:']);
  assert.deepEqual(directive(policy, 'frame-src'), ["'self'"]);
  assert.deepEqual(directive(policy, 'worker-src'), ["'self'", 'blob:']);
  assert.deepEqual(directive(policy, 'form-action'), ["'self'"]);
  assert.deepEqual(directive(policy, 'object-src'), ["'none'"]);
  assert.deepEqual(directive(policy, 'base-uri'), ["'self'"]);
  assert.ok(!directive(policy, 'script-src').some((s) => /^https?:|^\*$/.test(s)), 'no remote script source');
  assert.ok(!policy.includes('*'), 'no wildcard anywhere');
});

test('a declared host is reachable over TLS only; eval is a dev-only allowance', () => {
  const policy = contentSecurityPolicy({ egressHosts: ['api.acme.com', '*.voice.example'], dev: false });
  assert.deepEqual(directive(policy, 'connect-src').slice(3), [
    'https://api.acme.com', 'wss://api.acme.com', 'https://*.voice.example', 'wss://*.voice.example',
  ]);
  assert.ok(!directive(policy, 'connect-src').includes('http://api.acme.com'));
  assert.ok(!directive(policy, 'script-src').includes("'unsafe-eval'"));
  assert.ok(directive(policy, 'script-src').includes("'wasm-unsafe-eval'"));
  assert.ok(directive(contentSecurityPolicy({ egressHosts: [], dev: true }), 'script-src').includes("'unsafe-eval'"));
});

test('the request host is named for WebSockets only when it is a plain host', () => {
  const ok = contentSecurityPolicy({ egressHosts: [], dev: false, selfHost: '127.0.0.1:3101' });
  assert.ok(directive(ok, 'connect-src').includes('ws://127.0.0.1:3101'));
  assert.ok(directive(contentSecurityPolicy({ egressHosts: [], dev: false, selfHost: '[::1]:3101' }), 'connect-src').includes('wss://[::1]:3101'));
  for (const hostile of ['evil.com; script-src *', 'a b', "x'", 'host/path', '*']) {
    const policy = contentSecurityPolicy({ egressHosts: [], dev: false, selfHost: hostile });
    assert.deepEqual(directive(policy, 'connect-src'), ["'self'", 'data:', 'blob:'], hostile);
  }
});

test('only the page engines of mounted plugins open a host', () => {
  const hosts = pageEgressHosts({
    plugins: [
      dictationPlugin('acme', [
        { id: 'cloud', runtime: 'page', egress: ['api.acme.com'] },
        { id: 'local', runtime: 'page', egress: 'none' },
        // The host half's business, behind `pluginPolicy.http.allow`.
        { id: 'server', runtime: 'daemon', egress: ['daemon-side.acme.com'] },
      ]),
      dictationPlugin('off', [{ id: 'cloud', runtime: 'page', egress: ['disabled.example'] }], { state: 'disabled' }),
      dictationPlugin('headless', [{ id: 'cloud', runtime: 'page', egress: ['no-client.example'] }], { client: null }),
      { id: 'widget', state: 'active', client: { url: '/x' }, dictation: null },
    ],
  });
  assert.deepEqual(hosts, ['api.acme.com']);
});

test('a declaration out of the manifest grammar never reaches the header', () => {
  const hosts = pageEgressHosts([
    dictationPlugin('bad', [
      { id: 'inject', runtime: 'page', egress: ["evil.com; script-src 'unsafe-eval'"] },
      { id: 'url', runtime: 'page', egress: ['https://evil.com/path'] },
      { id: 'star', runtime: 'page', egress: ['*'] },
      { id: 'port', runtime: 'page', egress: ['evil.com:8443'] },
      { id: 'upper', runtime: 'page', egress: ['EVIL.COM'] },
    ]),
  ]);
  assert.deepEqual(hosts, []);
  assert.deepEqual(pageEgressHosts(null), []);
  assert.deepEqual(pageEgressHosts({ plugins: 'nope' }), []);
});

test('the host list is bounded, sorted and deduplicated', () => {
  const plugins = Array.from({ length: 20 }, (_, p) => dictationPlugin(`p${p}`, [
    { id: 'cloud', runtime: 'page', egress: Array.from({ length: 8 }, (_, h) => `h${h}.p${p}.example`) },
  ]));
  plugins.push(dictationPlugin('dup', [{ id: 'cloud', runtime: 'page', egress: ['h0.p0.example'] }]));
  const hosts = pageEgressHosts(plugins);
  assert.equal(hosts.length, MAX_EGRESS_HOSTS);
  assert.deepEqual(hosts, [...hosts].sort());
  assert.equal(new Set(hosts).size, hosts.length);
});

test('documents and workers ask for a fresh list, other requests do not', () => {
  assert.equal(wantsFreshPolicy('GET', { 'sec-fetch-dest': 'document' }), true);
  assert.equal(wantsFreshPolicy('GET', { 'sec-fetch-dest': 'iframe' }), true);
  assert.equal(wantsFreshPolicy('GET', { 'sec-fetch-dest': 'worker' }), true);
  assert.equal(wantsFreshPolicy('GET', { 'sec-fetch-dest': 'empty' }), false);
  assert.equal(wantsFreshPolicy('GET', { 'sec-fetch-dest': 'script' }), false);
  assert.equal(wantsFreshPolicy('POST', { 'sec-fetch-dest': 'document' }), false);
  assert.equal(wantsFreshPolicy('GET', { accept: 'text/html,application/xhtml+xml' }), true);
  assert.equal(wantsFreshPolicy('GET', { accept: 'application/json' }), false);
});

test('the egress source fails closed, keeps its last list, and reads once per TTL', async () => {
  let clock = 0;
  let calls = 0;
  let answer: () => Promise<unknown> = () => Promise.reject(new Error('daemon down'));
  const errors: unknown[] = [];
  const source = createEgressSource({
    load: () => { calls += 1; return answer(); },
    ttlMs: 1_000,
    now: () => clock,
    onError: (e) => errors.push(e),
  });
  await source.refresh();
  assert.deepEqual(source.hosts(), [], 'first failure: own origin only');
  assert.equal(errors.length, 1);
  await source.refresh();
  assert.equal(calls, 1, 'a failure is not retried on every page load');

  clock = 1_000;
  answer = async () => ({ plugins: [dictationPlugin('acme', [{ id: 'cloud', runtime: 'page', egress: ['api.acme.com'] }])] });
  await Promise.all([source.refresh(), source.refresh()]);
  assert.equal(calls, 2, 'concurrent refreshes share one read');
  assert.deepEqual(source.hosts(), ['api.acme.com']);

  clock = 2_500;
  answer = () => Promise.reject(new Error('restarting'));
  await source.refresh();
  assert.deepEqual(source.hosts(), ['api.acme.com'], 'a later failure keeps the last list');

  clock = 4_000;
  answer = async () => ({ plugins: [] });
  await source.refresh();
  assert.deepEqual(source.hosts(), [], 'an uninstalled engine loses its host');
});

async function serve(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const OURS = contentSecurityPolicy({ egressHosts: [], dev: false });

test('a route cannot loosen the policy: its own CSP is kept and ours is sent next to it', async () => {
  const cases: Record<string, (res: http.ServerResponse) => void> = {
    '/set-header': (res) => { res.setHeader('content-security-policy', 'default-src *'); res.end('x'); },
    '/write-head-object': (res) => { res.writeHead(200, { 'Content-Security-Policy': 'default-src *', 'content-type': 'text/html' }); res.end('x'); },
    '/write-head-reason': (res) => { res.writeHead(200, 'OK', { 'content-security-policy': 'default-src *' }); res.end('x'); },
    '/write-head-raw': (res) => { res.writeHead(200, ['Content-Security-Policy', 'default-src *']); res.end('x'); },
    '/none': (res) => { res.end('x'); },
    '/stream': (res) => { res.write('a'); res.end('b'); },
  };
  const app = await serve((req, res) => {
    enforceContentSecurityPolicy(res, OURS);
    enforceContentSecurityPolicy(res, 'second call is ignored');
    cases[req.url ?? '']!(res);
  });
  try {
    for (const path of Object.keys(cases)) {
      const res = await fetch(app.url + path);
      await res.text();
      const sent = res.headers.get('content-security-policy') ?? '';
      // Fetch joins repeated headers with ", ": each policy is enforced on its own.
      const policies = sent.split(/,\s*(?=default-src)/);
      assert.ok(policies.includes(OURS), `${path}: ours missing in ${sent}`);
      assert.ok(!sent.includes('second call'), path);
      if (path !== '/none' && path !== '/stream') assert.ok(policies.includes('default-src *'), `${path}: upstream policy dropped`);
    }
  } finally {
    await app.close();
  }
});

test('the server wiring refreshes on a document only and fails closed with no daemon', async () => {
  let refreshes = 0;
  const handler = createWindowPolicy({
    dev: false,
    source: { hosts: () => ['api.acme.com'], refresh: async () => { refreshes += 1; } },
  });
  const app = await serve((req, res) => { void handler(req, res).then(() => res.end('ok')); });
  try {
    const page = await fetch(app.url + '/chat', { headers: { 'sec-fetch-dest': 'document' } });
    await page.text();
    assert.equal(refreshes, 1);
    assert.ok(directive(page.headers.get('content-security-policy') ?? '', 'connect-src').includes('https://api.acme.com'));
    const api = await fetch(app.url + '/api/ui/stream', { headers: { 'sec-fetch-dest': 'empty' } });
    await api.text();
    assert.equal(refreshes, 1, 'an API call does not wait for the daemon');
    assert.ok(api.headers.get('content-security-policy'), 'an API response carries the policy too');
  } finally {
    await app.close();
  }
  assert.equal(CSP_HEADER.toLowerCase(), 'content-security-policy');
});
