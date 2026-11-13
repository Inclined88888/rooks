/**
 * The ACP framing codec against the product's own transport: what the codec
 * writes, `AcpTransport` must understand, and what `AcpTransport` writes, the
 * codec must classify. Two implementations of one wire are only trusted if they
 * are made to talk to each other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { decodeRpcLine, encodeRpcError, encodeRpcNotification, encodeRpcRequest, encodeRpcResult } from './acp-rpc.js';
import { RPC_METHOD_NOT_FOUND } from '../acp/wire.js';

const { AcpTransport } = await import('../acp/transport.js');

test('decodeRpcLine classifies the four message shapes', () => {
  assert.deepEqual(decodeRpcLine('{"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{"a":1}}'),
    { kind: 'request', id: 1, method: 'session/request_permission', params: { a: 1 } });
  assert.deepEqual(decodeRpcLine('{"jsonrpc":"2.0","method":"session/update","params":{}}'),
    { kind: 'notification', method: 'session/update', params: {} });
  assert.deepEqual(decodeRpcLine('{"jsonrpc":"2.0","id":"a","result":{"stopReason":"end_turn"}}'),
    { kind: 'result', id: 'a', result: { stopReason: 'end_turn' } });
  assert.deepEqual(decodeRpcLine('{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"auth","data":{"m":1}}}'),
    { kind: 'error', id: 2, code: -32000, message: 'auth', data: { m: 1 } });
});

test('decodeRpcLine is total: anything unusable is null, never an exception', () => {
  for (const line of ['', '  ', 'Welcome', '{"x":', 'null', '3', '[{"id":1,"result":1}]', '{}', '{"id":true,"result":1}', '{"id":1}']) {
    assert.equal(decodeRpcLine(line), null, JSON.stringify(line));
  }
  assert.deepEqual(decodeRpcLine('{"id":1,"error":"boom"}'), { kind: 'error', id: 1, code: -32603, message: 'agent error' });
});

test('every encoder writes exactly one newline-terminated line the decoder reads back', () => {
  const lines = [
    encodeRpcRequest(7, 'initialize', { protocolVersion: 1 }),
    encodeRpcNotification('session/cancel', { sessionId: 's' }),
    encodeRpcResult(9, { outcome: 'ok' }),
    encodeRpcError(9, RPC_METHOD_NOT_FOUND, 'nope', { why: 1 }),
  ];
  for (const line of lines) {
    assert.equal(line.endsWith('\n'), true);
    assert.equal(line.trimEnd().includes('\n'), false);
    assert.equal(JSON.parse(line).jsonrpc, '2.0');
    assert.notEqual(decodeRpcLine(line), null);
  }
});

test('the product transport reads what the codec writes, and the codec reads what the transport writes', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new AcpTransport({ io: { stdin, stdout } });
  const written: string[] = [];
  stdin.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));

  const pending = transport.request('initialize', { protocolVersion: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const sent = decodeRpcLine(written.join(''));
  assert.equal(sent?.kind, 'request');
  assert.equal(sent?.kind === 'request' ? sent.method : '', 'initialize');

  stdout.write(encodeRpcResult(sent?.kind === 'request' ? sent.id : -1, { agentInfo: 'fake' }));
  assert.deepEqual(await pending, { agentInfo: 'fake' });

  // An agent request the product does not serve gets the standard refusal, which the codec reads.
  written.length = 0;
  stdout.write(encodeRpcRequest('x1', 'fs/read_text_file', {}));
  await new Promise((resolve) => setImmediate(resolve));
  const refusal = decodeRpcLine(written.join(''));
  assert.equal(refusal?.kind, 'error');
  assert.equal(refusal?.kind === 'error' ? refusal.code : 0, RPC_METHOD_NOT_FOUND);
  transport.dispose();
});
