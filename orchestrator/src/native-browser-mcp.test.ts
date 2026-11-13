import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function harness(t: TestContext, respond: (body: any) => { status?: number; error?: string; result?: unknown }) {
  const requests: { path: string; auth?: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push({ path: req.url!, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    const response = respond(body);
    res.statusCode = response.status ?? 200;
    res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = (token: string) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/browser-mcp.mjs', import.meta.url))], {
      env: { ...process.env, ROOKS_API_TOKEN: token, ROOKS_ORCH_URL: origin }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => { child.kill(); });
    let id = 0;
    const replies = new Map<number, (value: any) => void>();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => { const value = JSON.parse(line); replies.get(value.id)?.(value); replies.delete(value.id); });
    return async (method: string, params?: unknown) => {
      const sequence = ++id;
      const reply = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('MCP reply timed out')), 5000);
        replies.set(sequence, (value) => { clearTimeout(timeout); resolve(value); });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: sequence, method, params })}\n`);
      return reply;
    };
  };
  return { requests, client };
}

test('browser MCP uses only mission-authenticated commands and returns native screenshots as images', async (t) => {
  const { requests, client } = await harness(t, (body) => body.action === 'input'
    ? { status: 409, error: 'Another controller is using this browser.' }
    : { result: body.action === 'screenshot'
      ? { data: 'aW1hZ2U=', mimeType: 'image/jpeg', width: 1366, height: 768 }
      : { running: true, tabs: [{ id: 'only-this-profile', url: 'https://example.com' }] } });
  const rpc = client('mission-scoped-secret');
  assert.equal((await rpc('initialize')).result.serverInfo.name, 'rooks-browser');
  const catalogue = (await rpc('tools/list')).result.tools;
  assert.ok(catalogue.find((entry: any) => entry.name === 'take_snapshot'));
  assert.ok(catalogue.every((entry: any) => !entry.inputSchema.properties.profileId));
  const shot = await rpc('tools/call', { name: 'take_screenshot', arguments: { profileId: 'spoof-other-profile' } });
  assert.deepEqual(shot.result.content, [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/jpeg' }]);
  assert.ok(requests.every(({ path, auth, body }) => path === '/api/native-browser/mission/command'
    && auth === 'Bearer mission-scoped-secret' && !('profileId' in body)));
  const conflict = await rpc('tools/call', { name: 'press_key', arguments: { key: 'Enter' } });
  assert.equal(conflict.result.isError, true);
  assert.match(conflict.result.content[0].text, /Another controller/);
  const noToken = client('');
  const count = requests.length;
  const denied = await noToken('tools/call', { name: 'list_pages' });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /mission token is required/);
  assert.equal(requests.length, count, 'no daemon-token fallback or unscoped browser request');
});

test('credential and dialog MCP tools forward identifiers without accepting plaintext or human-only permission operations', async (t) => {
  const { requests, client } = await harness(t, (body) => ({ result: body.action === 'listCredentials'
    ? { credentials: [{ id: 'bc-test', origin: 'https://client.example', usernameHint: 'a•••' }] }
    : body.action === 'fillCredential' ? { filled: true } : { running: true } }));
  const rpc = client('mission-only');
  const catalogue = (await rpc('tools/list')).result.tools;
  assert.ok(catalogue.some((tool: any) => tool.name === 'list_credentials'));
  assert.deepEqual(Object.keys(catalogue.find((tool: any) => tool.name === 'fill_credential').inputSchema.properties), ['credentialId']);
  assert.ok(catalogue.every((tool: any) => !/capture|save_credential|permission/.test(tool.name)));
  const list = await rpc('tools/call', { name: 'list_credentials' });
  assert.equal(JSON.parse(list.result.content[0].text).credentials[0].id, 'bc-test');
  const filled = await rpc('tools/call', { name: 'fill_credential', arguments: { credentialId: 'bc-test', password: 'must-not-forward', username: 'must-not-forward', origin: 'https://evil.test', profileId: 'foreign' } });
  assert.deepEqual(JSON.parse(filled.result.content[0].text), { filled: true });
  assert.deepEqual(requests.at(-1)?.body, { action: 'fillCredential', credentialId: 'bc-test' });
  await rpc('tools/call', { name: 'handle_dialog', arguments: { dialogId: 'dialog-id', accept: true, promptText: 'Answer' } });
  assert.deepEqual(requests.at(-1)?.body, { action: 'dialogRespond', dialogId: 'dialog-id', accept: true, promptText: 'Answer' });
  const count = requests.length;
  assert.equal((await rpc('tools/call', { name: 'permissionRespond', arguments: { allow: true } })).result.isError, true);
  assert.equal(requests.length, count);
});

test('MCP transfers local files through bounded profile commands without sending host paths or overwriting existing files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rooks-browser-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.alloc(128 * 1024 * 2 + 17, 'transfer-file-data');
  const source = join(directory, 'input.txt'); const empty = join(directory, 'empty.txt'); const destination = join(directory, 'output.txt');
  await writeFile(source, payload); await writeFile(empty, '');
  const uploads = new Map<string, Buffer>(); let uploadCount = 0;
  const { requests, client } = await harness(t, (body) => {
    if (body.action === 'fileUploadBegin') { const uploadId = `upload-${++uploadCount}`; uploads.set(uploadId, Buffer.alloc(0)); return { result: { uploadId, offset: 0 } }; }
    if (body.action === 'fileUploadChunk') {
      const previous = uploads.get(body.uploadId)!; const chunk = Buffer.from(body.data, 'base64');
      assert.equal(body.offset, previous.length); assert.ok(chunk.length <= 128 * 1024);
      uploads.set(body.uploadId, Buffer.concat([previous, chunk]));
      return { result: { uploadId: body.uploadId, offset: previous.length + chunk.length } };
    }
    if (body.action === 'downloadRead') {
      const bytes = payload.subarray(body.offset, body.offset + body.length);
      return { result: { data: bytes.toString('base64'), offset: body.offset, size: payload.length, eof: body.offset + bytes.length === payload.length } };
    }
    return { result: { running: true } };
  });
  const rpc = client('mission-transfer');
  const uploaded = await rpc('tools/call', { name: 'upload_file', arguments: { chooserId: 'chooser-id', filePaths: [source, empty] } });
  assert.ok(!uploaded.result.isError);
  assert.deepEqual(uploads.get('upload-1'), payload); assert.equal(uploads.get('upload-2')?.length, 0);
  assert.deepEqual(requests.at(-1)?.body, { action: 'fileUploadCommit', chooserId: 'chooser-id', uploadIds: ['upload-1', 'upload-2'] });
  const downloaded = await rpc('tools/call', { name: 'download_file', arguments: { downloadId: 'download-id', filePath: destination } });
  assert.ok(!downloaded.result.isError); assert.deepEqual(await readFile(destination), payload);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(requests).includes(directory), 'filesystem paths never leave the MCP process');
  const previousReads = requests.filter(({ body }) => body.action === 'downloadRead').length;
  const collision = await rpc('tools/call', { name: 'download_file', arguments: { downloadId: 'download-id', filePath: destination } });
  assert.equal(collision.result.isError, true); assert.deepEqual(await readFile(destination), payload);
  assert.equal(requests.filter(({ body }) => body.action === 'downloadRead').length, previousReads);
});

test('failed transfers cancel uploads and remove only their newly created partial download', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rooks-browser-mcp-fail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'input.txt'); const destination = join(directory, 'incomplete.txt');
  await writeFile(source, 'selected-data');
  const { requests, client } = await harness(t, (body) => {
    if (body.action === 'fileUploadBegin') return { result: { uploadId: 'upload-failed', offset: 0 } };
    if (body.action === 'fileUploadChunk') return { status: 409, error: 'Control changed.' };
    if (body.action === 'downloadRead') return { result: { offset: 0, data: '', size: 12, eof: false } };
    return { result: { running: true } };
  });
  const rpc = client('mission-transfer');
  assert.equal((await rpc('tools/call', { name: 'upload_file', arguments: { chooserId: 'chooser-id', filePaths: [source] } })).result.isError, true);
  assert.deepEqual(requests.at(-1)?.body, { action: 'fileUploadCancel', chooserId: 'chooser-id' });
  assert.equal(await readFile(source, 'utf8'), 'selected-data');
  assert.equal((await rpc('tools/call', { name: 'download_file', arguments: { downloadId: 'download-id', filePath: destination } })).result.isError, true);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('devtools MCP tools keep chrome-devtools-mcp names and forward only their own bounded arguments', async (t) => {
  let present = false;
  const { requests, client } = await harness(t, (body) => {
    if (body.action === 'evaluate') {
      if (body.expression.includes('innerText.includes')) { const found = present; present = true; return { result: { result: found } }; }
      return { result: { result: body.expression.includes("tagName==='SELECT'") ? 'text' : { x: 10, y: 20 } } };
    }
    return { result: { ok: true } };
  });
  const rpc = client('mission-devtools');
  const names = (await rpc('tools/list')).result.tools.map((tool: any) => tool.name);
  for (const name of ['list_console_messages', 'get_console_message', 'list_network_requests', 'get_network_request', 'emulate',
    'performance_start_trace', 'performance_stop_trace', 'hover', 'drag', 'fill_form', 'wait_for']) assert.ok(names.includes(name), name);
  const forwarded = async (name: string, args: Record<string, unknown>) => {
    assert.ok(!(await rpc('tools/call', { name, arguments: { ...args, profileId: 'foreign' } })).result.isError, name);
    return requests.at(-1)?.body;
  };
  assert.deepEqual(await forwarded('list_console_messages', { types: ['error'] }), { action: 'consoleList', types: ['error'] });
  assert.deepEqual(await forwarded('get_network_request', { reqid: 3 }), { action: 'networkGet', reqid: 3 });
  assert.deepEqual(await forwarded('emulate', { networkConditions: 'Slow 3G', cpuThrottlingRate: 4 }), { action: 'emulate', networkConditions: 'Slow 3G', cpuThrottlingRate: 4 });
  assert.deepEqual(await forwarded('performance_start_trace', { reload: true, autoStop: true }), { action: 'performanceStart', reload: true, autoStop: true });
  assert.deepEqual(await forwarded('hover', { uid: '4' }), { action: 'input', event: { type: 'move', x: 10, y: 20, button: 'none' } });
  assert.deepEqual(await forwarded('drag', { from_uid: '1', to_uid: '2' }), { action: 'input', event: { type: 'up', x: 10, y: 20 } });
  assert.deepEqual(await forwarded('fill_form', { elements: [{ uid: '1', value: 'Ada' }] }), { action: 'input', event: { type: 'text', text: 'Ada' } });
  assert.deepEqual(JSON.parse((await rpc('tools/call', { name: 'wait_for', arguments: { text: 'Done', timeout: 2000 } })).result.content[0].text), { found: 'Done' });
  assert.ok(requests.every(({ body }) => !('profileId' in body)));
  const injected = await rpc('tools/call', { name: 'hover', arguments: { uid: '1"]);alert(1)//' } });
  assert.equal(injected.result.isError, true, 'uids are validated before reaching the page');
});
