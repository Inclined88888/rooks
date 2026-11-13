import assert from 'node:assert/strict';
import test from 'node:test';
import { DevtoolsLog, metricsDelta, redactHeaders, remoteObjectText } from './native-browser-devtools.js';

const documentRequest = (requestId: string, url: string, frameId = 'main') => ({
  requestId, loaderId: requestId, frameId, type: 'Document', wallTime: 1, request: { method: 'GET', url, headers: {} },
});

test('secret headers never reach the agent, other headers do', () => {
  assert.deepEqual(redactHeaders({ Cookie: 'sid=1', 'set-cookie': 'a=b', Authorization: 'Bearer x', 'Proxy-Authorization': 'p', Accept: 'text/html' }),
    { Cookie: '<redacted>', 'set-cookie': '<redacted>', Authorization: '<redacted>', 'Proxy-Authorization': '<redacted>', Accept: 'text/html' });
  const log = new DevtoolsLog('main');
  log.handle('Network.requestWillBeSent', { ...documentRequest('r1', 'https://example.com/'), request: { method: 'GET', url: 'https://example.com/', headers: { Cookie: 'sid=secret' } } });
  log.handle('Network.responseReceived', { requestId: 'r1', response: { status: 200, headers: { 'Set-Cookie': 'sid=new' }, mimeType: 'text/html' } });
  const entry = log.getNetwork(1)!;
  assert.equal(entry.requestHeaders.Cookie, '<redacted>');
  assert.equal(entry.responseHeaders!['Set-Cookie'], '<redacted>');
  assert.ok(!JSON.stringify(entry).includes('secret'));
});

test('console messages render like DevTools and are filtered and paged', () => {
  const log = new DevtoolsLog('main');
  log.handle('Runtime.consoleAPICalled', { type: 'log', timestamp: 1, args: [{ type: 'string', value: 'hello' }, { type: 'number', value: 42 }],
    stackTrace: { callFrames: [{ functionName: 'f', url: 'https://example.com/app.js', lineNumber: 9, columnNumber: 0 }] } });
  log.handle('Runtime.exceptionThrown', { timestamp: 2, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom' } } });
  log.handle('Log.entryAdded', { entry: { source: 'console-api', level: 'info', text: 'duplicate of Runtime' } });
  log.handle('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'Failed to load resource: 404' } });
  const all = log.listConsole({});
  assert.equal(all.total, 3);
  assert.deepEqual(all.messages[0], { msgid: 1, type: 'log', text: 'hello 42', source: 'https://example.com/app.js:10' });
  assert.deepEqual(log.listConsole({ types: ['error'] }).messages.map((m) => m.text), ['TypeError: boom', 'Failed to load resource: 404']);
  assert.equal(log.listConsole({ pageSize: 1, pageIdx: 2 }).messages[0]!.msgid, 3);
  assert.deepEqual(log.getConsole(1)!.stack, ['f https://example.com/app.js:10:1']);
});

test('a new main-frame document starts a fresh history; subframes and redirects do not', () => {
  const log = new DevtoolsLog('main');
  log.handle('Network.requestWillBeSent', documentRequest('d1', 'https://a.test/'));
  log.handle('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'old page' }] });
  log.handle('Network.requestWillBeSent', documentRequest('f1', 'https://ads.test/', 'child'));
  assert.equal(log.listNetwork({}).total, 2);
  log.handle('Network.requestWillBeSent', documentRequest('d2', 'http://b.test/'));
  log.handle('Network.requestWillBeSent', { ...documentRequest('d2', 'https://b.test/'), redirectResponse: { status: 301, headers: {} } });
  const requests = log.listNetwork({}).requests;
  assert.deepEqual(requests.map((r) => [r.url, r.status, r.state]), [['http://b.test/', 301, 'finished'], ['https://b.test/', undefined, 'pending']]);
  assert.equal(log.listConsole({}).total, 0);
});

test('history is bounded and failures are reported', () => {
  const log = new DevtoolsLog('main', 3);
  for (let i = 0; i < 5; i++) log.handle('Network.requestWillBeSent', { requestId: `x${i}`, type: 'Fetch', request: { url: `https://api.test/${i}` } });
  log.handle('Network.loadingFailed', { requestId: 'x4', errorText: 'net::ERR_FAILED' });
  const listed = log.listNetwork({ resourceTypes: ['fetch'] });
  assert.equal(listed.total, 3);
  assert.deepEqual(listed.requests.at(-1), { reqid: 5, method: 'GET', url: 'https://api.test/4', resourceType: 'Fetch', status: undefined, state: 'failed', errorText: 'net::ERR_FAILED' });
  const tracked = (log as unknown as { requests: Map<string, unknown> }).requests;
  assert.deepEqual([...tracked.keys()], ['x2', 'x3', 'x4'], 'evicted requests are no longer tracked');
  log.handle('Network.responseReceived', { requestId: 'x0', response: { status: 500 } });
  assert.ok(log.listNetwork({}).requests.every((r) => r.status !== 500));
});

test('remote objects and metrics are summarised for reading', () => {
  assert.equal(remoteObjectText({ type: 'object', className: 'Object', preview: { properties: [{ name: 'a', value: '1' }], overflow: false } }), '{a: 1}');
  assert.equal(remoteObjectText({ type: 'object', subtype: 'array', className: 'Array', preview: { subtype: 'array', properties: [{ name: '0', value: '1' }] } }), '[1]');
  assert.equal(remoteObjectText({ type: 'undefined' }), 'undefined');
  assert.deepEqual(metricsDelta([{ name: 'ScriptDuration', value: 0.1 }], [{ name: 'ScriptDuration', value: 0.35 }, { name: 'JSHeapUsedSize', value: 12_345_678 }, { name: 'Nodes', value: 80 }]),
    { scriptDurationMs: 250, taskDurationMs: null, layoutDurationMs: null, recalcStyleDurationMs: null, layoutCount: null, jsHeapUsedMB: 12.3, nodes: 80, documents: null });
});
