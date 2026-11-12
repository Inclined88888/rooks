import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stageUpload } from '../../../../plugins/agent-import/src/readers/upload';
import { ZIP_UPLOAD_MAX_BYTES } from '../../../../plugins/agent-import/src/readers/limits';

(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;

interface Seen {
  method: string;
  url: string;
  contentType: string | undefined;
  contentLength: string | undefined;
  authorization: string | undefined;
  cookie: string | undefined;
  body: string;
  bytes: Buffer;
}

let seen: Seen[] = [];
function call(i: number): Seen {
  const s = seen[i];
  assert.ok(s, `the daemon received no call #${i}`);
  return s;
}

/** Replaces the daemon's answer for one test: the default is `{ created: 2 }`. */
let route: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null;

const server = createServer((req: IncomingMessage, res) => {
  if (route?.(req, res)) return;
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  req.on('end', () => {
    const bytes = Buffer.concat(chunks);
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      body: bytes.toString('utf8'),
      bytes,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ created: 2 }));
  });
});

let proxyPluginRequest!: typeof import('./plugin-proxy').proxyPluginRequest;
let PLUGIN_BINARY_BODY_MAX_BYTES!: number;
const params = { id: 'hermes-gateway', path: ['agents'] };
const url = 'http://rooks.localhost/api/ui/plugins/hermes-gateway/agents';

test.before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  process.env.ORCHESTRATOR_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ({ proxyPluginRequest, PLUGIN_BINARY_BODY_MAX_BYTES } = await import('./plugin-proxy'));
});

test.beforeEach(() => { seen = []; route = null; });

test.after(() => {
  server.closeAllConnections();
  server.close();
});

test('a POST without a body is relayed without one', async () => {
  const res = await proxyPluginRequest('POST', new Request(url, { method: 'POST' }), params);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { created: 2 });
  assert.equal(seen.length, 1);
  assert.equal(call(0).method, 'POST');
  assert.equal(call(0).url, '/api/plugins/hermes-gateway/agents');
  assert.equal(call(0).body, '');
  assert.equal(call(0).contentType, undefined);
});

test('a JSON body is relayed as JSON', async () => {
  const req = new Request(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  const res = await proxyPluginRequest('PUT', req, params);
  assert.equal(res.status, 200);
  assert.equal(call(0).method, 'PUT');
  assert.equal(call(0).contentType, 'application/json');
  assert.deepEqual(JSON.parse(call(0).body), { a: 1 });
});

test('an invalid JSON body is a 400 and never reaches the daemon', async () => {
  const req = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  const res = await proxyPluginRequest('POST', req, params);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid JSON body' });
  assert.equal(seen.length, 0);
});

test('DELETE and PATCH reach the plugin router', async () => {
  await proxyPluginRequest('DELETE', new Request(url, { method: 'DELETE' }), params);
  await proxyPluginRequest('PATCH', new Request(url, { method: 'PATCH', body: '{"b":true}' }), params);
  assert.deepEqual(seen.map((s) => s.method), ['DELETE', 'PATCH']);
  assert.deepEqual(JSON.parse(call(1).body), { b: true });
});

test('the query string and encoded segments are kept', async () => {
  const req = new Request(`${url}?state=ok&q=a%20b`);
  await proxyPluginRequest('GET', req, { id: 'hermes-gateway', path: ['by name', 'x'] });
  assert.equal(call(0).method, 'GET');
  assert.equal(call(0).url, '/api/plugins/hermes-gateway/by%20name/x?state=ok&q=a%20b');
});

// ── Binary bodies (an archive sent by a plugin's browser half) ─────────────

const stageParams = { id: 'agent-import', path: ['stage'] };
const stageUrl = 'http://rooks.localhost/api/ui/plugins/agent-import/stage';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A zip-looking archive (local header magic) with random content. */
function archive(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(randomBytes(size));
  bytes[0] = 0x50; bytes[1] = 0x4b; bytes[2] = 0x03; bytes[3] = 0x04;
  return bytes;
}

/** A body the test can tell was never pulled: `pulled` stays false. */
function watchedBody(bytes: Uint8Array): { body: ReadableStream<Uint8Array>; pulled: () => boolean } {
  let pulled = false;
  // highWaterMark 0: the stream asks for nothing until somebody reads it.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled = true;
      controller.enqueue(bytes);
      controller.close();
    },
  }, { highWaterMark: 0 });
  return { body, pulled: () => pulled };
}

function streamedRequest(body: ReadableStream<Uint8Array>, headers: Record<string, string>): Request {
  return new Request(stageUrl, { method: 'POST', headers, body, duplex: 'half' } as RequestInit & { duplex: 'half' });
}

test('an anonymous binary upload reaches the daemon with no credential, and its refusal comes back', async () => {
  const previous = process.env.ROOKS_DAEMON_TOKEN;
  process.env.ROOKS_DAEMON_TOKEN = 'daemon-token-must-not-leak';
  route = (req, res) => {
    if (req.headers.authorization || req.headers.cookie) return false;
    req.resume();
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'unauthorized' }));
    return true;
  };
  try {
    const req = new Request(stageUrl, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: archive(64) });
    const res = await proxyPluginRequest('POST', req, stageParams);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { code: 'unauthorized' });
    assert.equal(seen.length, 0, 'the daemon must not see a credential on an anonymous upload');
  } finally {
    if (previous === undefined) delete process.env.ROOKS_DAEMON_TOKEN;
    else process.env.ROOKS_DAEMON_TOKEN = previous;
  }
});

test('a declared length past the ceiling is a 413 before the body is read', async () => {
  const { body, pulled } = watchedBody(new Uint8Array(16));
  const req = streamedRequest(body, {
    'content-type': 'application/zip',
    'content-length': String(PLUGIN_BINARY_BODY_MAX_BYTES + 1),
  });
  const res = await proxyPluginRequest('POST', req, stageParams);
  assert.equal(res.status, 413);
  assert.equal(((await res.json()) as { code: string }).code, 'body_too_large');
  assert.equal(pulled(), false, 'the body must not be read');
  assert.equal(seen.length, 0);
});

test('a malformed Content-Length on a binary body is a 400 and never reaches the daemon', async () => {
  const { body } = watchedBody(new Uint8Array(4));
  const res = await proxyPluginRequest('POST', streamedRequest(body, { 'content-type': 'application/zip', 'content-length': '12abc' }), stageParams);
  assert.equal(res.status, 400);
  assert.equal(seen.length, 0);
});

test('a chunked binary body is cut off at the ceiling and answered 413', async () => {
  route = (req, res) => {
    // The daemon reads until the relay gives up.
    req.on('data', () => {});
    req.on('error', () => {});
    req.on('close', () => { if (!res.writableEnded) res.destroy(); });
    return true;
  };
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += chunk.byteLength;
      controller.enqueue(chunk);
      if (sent > PLUGIN_BINARY_BODY_MAX_BYTES + 4 * chunk.byteLength) controller.close();
    },
  });
  const res = await proxyPluginRequest('POST', streamedRequest(body, { 'content-type': 'application/octet-stream' }), stageParams);
  assert.equal(res.status, 413);
  assert.ok(sent <= PLUGIN_BINARY_BODY_MAX_BYTES + 4 * chunk.byteLength);
});

test('a type not declared binary keeps the JSON path', async () => {
  const req = new Request(stageUrl, { method: 'POST', headers: { 'content-type': 'image/png' }, body: '{"a":1}' });
  const res = await proxyPluginRequest('POST', req, stageParams);
  assert.equal(res.status, 200);
  assert.equal(call(0).contentType, 'application/json');
  assert.deepEqual(JSON.parse(call(0).body), { a: 1 });

  const bytes = new Request(stageUrl, { method: 'POST', headers: { 'content-type': 'image/png' }, body: archive(32) });
  const refused = await proxyPluginRequest('POST', bytes, stageParams);
  assert.equal(refused.status, 400, 'bytes under an undeclared type are not relayed');
  assert.equal(seen.length, 1);
});

test('a zip is relayed byte for byte, with its type and length', async () => {
  const bytes = archive(3 * 1024 * 1024 + 17);
  for (const type of ['application/zip', 'application/x-zip-compressed', 'application/octet-stream']) {
    seen = [];
    // What a browser sends for a `Blob` body: its type and its length.
    const req = new Request(stageUrl, {
      method: 'POST',
      headers: { 'content-type': type, 'content-length': String(bytes.length) },
      body: new Blob([new Uint8Array(bytes)]),
    });
    const res = await proxyPluginRequest('POST', req, stageParams);
    assert.equal(res.status, 200, type);
    assert.equal(call(0).url, '/api/plugins/agent-import/stage');
    assert.equal(call(0).contentType, type);
    assert.equal(call(0).contentLength, String(bytes.length));
    assert.equal(sha256(call(0).bytes), sha256(bytes), type);
  }
});

test('the ceiling is the one agent-import stage enforces', () => {
  assert.equal(PLUGIN_BINARY_BODY_MAX_BYTES, ZIP_UPLOAD_MAX_BYTES);
});

test('end to end: the relayed zip staged by agent-import has the SHA the browser sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-proxy-stage-'));
  const staged: Promise<{ path: string; size: number; dispose: () => Promise<void> }>[] = [];
  route = (req, res) => {
    const upload = stageUpload(req as AsyncIterable<Uint8Array>, { dir, declaredBytes: Number(req.headers['content-length']) });
    staged.push(upload);
    upload.then(
      (up) => { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ size: up.size })); },
      () => { res.writeHead(500); res.end(); },
    );
    return true;
  };
  try {
    const bytes = archive(1024 * 1024 + 3);
    const file = new File([new Uint8Array(bytes)], 'agents.zip', { type: 'application/zip' });
    const req = new Request(stageUrl, {
      method: 'POST',
      headers: { 'content-type': file.type, 'content-length': String(file.size) },
      body: file,
    });
    const res = await proxyPluginRequest('POST', req, stageParams);
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { size: bytes.length });
    const upload = staged[0];
    assert.ok(upload, 'agent-import staged nothing');
    const up = await upload;
    assert.equal(sha256(readFileSync(up.path)), sha256(bytes));
    await up.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
