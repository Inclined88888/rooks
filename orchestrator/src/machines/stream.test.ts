/**
 * The event-stream reader of the push relay: the parser alone, then what the
 * stream does with a machine that answers anything but a stream.
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStreamParser, openMachineStream, type MachineStreamEnd } from './stream.js';

test('the parser dispatches named events, joins data lines and skips comments', () => {
  const seen: Array<[string, string]> = [];
  const parser = new EventStreamParser((name, data) => seen.push([name, data]), 1024);
  assert.equal(parser.push(': ping\n\nevent: notifications_changed\r\ndata: {"a"'), true);
  assert.equal(parser.push(':1}\r\n\r\ndata: one\ndata: two\n\n'), true);
  assert.deepEqual(seen, [['notifications_changed', '{"a":1}'], ['message', 'one\ntwo']]);
});

test('the parser refuses one event larger than its cap, not many small ones', () => {
  const parser = new EventStreamParser(() => {}, 64);
  assert.equal(parser.push('data: x\n\n'.repeat(50)), true, 'many small events in one chunk');
  assert.equal(parser.push(`data: ${'x'.repeat(100)}`), false, 'one oversized event');
});

const server = createServer((req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { location: 'http://169.254.169.254/' });
    res.end();
  } else if (req.url === '/silent') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  } else {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"unauthorized"}');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

function endOf(path: string, idleMs?: number): Promise<MachineStreamEnd> {
  return new Promise((resolve) => {
    openMachineStream(base, { path, token: 'tdev_x', idleMs }, { onEvent: () => {}, onEnd: resolve });
  });
}

test('a refusal, a redirect, a silent stream and a refused URL each end the stream, typed', async () => {
  assert.deepEqual(await endOf('/api/stream'), { kind: 'refused', status: 401 });
  const redirect = await endOf('/redirect');
  assert.equal(redirect.kind === 'error' && redirect.error.code, 'redirect');
  const silent = await endOf('/silent', 100);
  assert.equal(silent.kind === 'error' && silent.error.code, 'timeout');
  const refused = await new Promise<MachineStreamEnd>((resolve) => {
    openMachineStream('http://example.com', { path: '/api/stream', token: 'tdev_x' }, { onEvent: () => {}, onEnd: resolve });
  });
  assert.equal(refused.kind === 'error' && refused.error.code, 'invalid_url');
});
