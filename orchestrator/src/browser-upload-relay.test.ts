import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { UPLOAD_RELAY_SPEC_ENV, parseUploadRelaySpec, relayClientLine, type UploadRelaySpec } from './browser-upload-relay.js';

const WIN = { mount: { source: 'D:\\Projects\\X', target: '/host/d/Projects/X' }, platform: 'win32' as const };

function upload(filePaths: unknown, id: number | string = 7): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'upload_file', arguments: { uid: '1_3', filePaths } } });
}

test('upload_file: Windows host paths are rewritten to their container path', () => {
  const decision = relayClientLine(upload(['D:\\Projects\\X\\a.png', 'd:/projects/x/sub/b c.txt']), WIN);
  assert.ok('forward' in decision);
  const sent = JSON.parse(decision.forward);
  assert.deepEqual(sent.params.arguments, { uid: '1_3', filePaths: ['/host/d/Projects/X/a.png', '/host/d/Projects/X/sub/b c.txt'] });
  assert.equal(sent.id, 7);
});

test('upload_file: a path outside the project is answered with a tool error, never forwarded', () => {
  const decision = relayClientLine(upload(['D:\\Projects\\X\\a.png', 'C:\\Users\\robin\\secret.txt'], 'req-1'), WIN);
  assert.ok('reply' in decision);
  const reply = JSON.parse(decision.reply);
  assert.equal(reply.id, 'req-1');
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /C:\\Users\\robin\\secret\.txt/);
  assert.match(reply.result.content[0].text, /D:\\Projects\\X/);
});

test('every other message crosses byte for byte', () => {
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'navigate_page', arguments: { url: 'D:\\x' } } }),
    JSON.stringify([{ jsonrpc: '2.0', id: 3, method: 'tools/list' }]),
    upload('not-an-array'),
    'not json at all',
  ];
  for (const line of lines) assert.deepEqual(relayClientLine(line, WIN), { forward: line });
});

test('outside Windows the paths are left as they are', () => {
  const line = upload(['/home/user/x/a.png']);
  const decision = relayClientLine(line, { mount: { source: '/home/user/x', target: '/home/user/x' }, platform: 'linux' });
  assert.ok('forward' in decision);
  assert.deepEqual(JSON.parse(decision.forward).params.arguments.filePaths, ['/home/user/x/a.png']);
});

test('a malformed spec is refused', () => {
  assert.throws(() => parseUploadRelaySpec(undefined));
  assert.throws(() => parseUploadRelaySpec(JSON.stringify({ command: 'npx', args: [1], mount: WIN.mount, platform: 'win32' })), /invalid/);
  assert.throws(() => parseUploadRelaySpec(JSON.stringify({ command: 'npx', args: [], platform: 'win32' })), /invalid/);
});

/** Fake MCP server: answers each request with the arguments it received. */
const ECHO_SERVER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (l) => { const m = JSON.parse(l); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { got: m.params } }) + '\\n'); });
rl.on('close', () => process.exit(0));
`;

function startRelay(t: TestContext) {
  const spec: UploadRelaySpec = { command: process.execPath, args: ['-e', ECHO_SERVER], ...WIN };
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./browser-upload-relay-runner.ts', import.meta.url))], {
    env: { ...process.env, [UPLOAD_RELAY_SPEC_ENV]: JSON.stringify(spec) }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => { child.kill(); });
  const replies = new Map<unknown, (value: { result: Record<string, unknown> }) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const value = JSON.parse(line);
    replies.get(value.id)?.(value);
  });
  return {
    child,
    send(line: string, id: unknown) {
      const reply = new Promise<{ result: Record<string, unknown> }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('relay reply timed out')), 10_000);
        replies.set(id, (value) => { clearTimeout(timer); resolve(value); });
      });
      child.stdin.write(`${line}\n`);
      return reply;
    },
  };
}

test('the relay runner translates on the way to the server and answers the rest itself', async (t) => {
  const relay = startRelay(t);
  const translated = await relay.send(upload(['D:\\Projects\\X\\a.png'], 1), 1);
  assert.deepEqual((translated.result.got as { arguments: unknown }).arguments, { uid: '1_3', filePaths: ['/host/d/Projects/X/a.png'] });

  const refused = await relay.send(upload(['C:\\elsewhere.txt'], 2), 2);
  assert.equal(refused.result.isError, true);
  assert.equal(refused.result.got, undefined, 'the server never saw the request');

  const passthrough = await relay.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }), 3);
  assert.ok(passthrough.result.got === undefined || passthrough.result.got === null);

  relay.child.stdin.end();
  const [code] = await new Promise<[number | null]>((resolve) => relay.child.once('exit', (c) => resolve([c])));
  assert.equal(code, 0, 'the relay exits with the server once the client hangs up');
});
