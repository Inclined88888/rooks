/**
 * The codec toolkit published to provider authors: line framing, the event
 * vocabulary factories and the shared `extractSessionId`. The factories are
 * checked against what the product's own dialects write — a factory that
 * drifted from `codex.parseLine` would teach third parties a vocabulary the
 * rest of Timon does not read.
 */

import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeJsonLine, parseJsonLine, parseJsonObjectLine } from './json-lines.js';
import {
  assistantDeltaEvent, assistantTextEvent, assistantThinkingEvent, extractInitSessionId, providerRetryEvent,
  providerRetryKind, resultErrorEvent, resultSuccessEvent, systemInitEvent, toolResultEvent, toolUseEvent,
} from './events.js';
import { partialTextDelta, streamJsonUser } from './stream-json.js';
import { rateLimitFromEvent } from '../../rate-limit.js';

const kit = await import('../../../../packages/sdk/src/testing/index.js');
const codexPlugin = await import('../../../official-providers/provider-codex/lib/index.js') as { apply(ctx: unknown): void };
const codexCtx = kit.createProviderContext();
codexPlugin.apply(codexCtx);
const codexDialect = codexCtx.registered.dialect('codex') as import('../types.js').Dialect;
const { claudeDialect } = await import('../../../tests/helpers/claude-provider.js');

test('parseJsonLine never throws, and tells null apart from not-JSON', () => {
  assert.equal(parseJsonLine('{"a":1}') !== undefined, true);
  assert.equal(parseJsonLine('null'), null);
  for (const line of ['', '   ', 'Welcome!', '{"type":', '\u0000\u0001', 'undefined']) {
    assert.equal(parseJsonLine(line), undefined, JSON.stringify(line));
  }
});

test('parseJsonObjectLine keeps objects and drops everything else', () => {
  assert.deepEqual(parseJsonObjectLine('{"type":"x"}'), { type: 'x' });
  for (const line of ['null', '3', '"text"', '[1,2]', 'true', 'nope', '']) {
    assert.equal(parseJsonObjectLine(line), null, line);
  }
});

test('encodeJsonLine is one value, one newline-terminated line, and round-trips', () => {
  const value = { type: 'user', text: 'a\nb' };
  const line = encodeJsonLine(value);
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.slice(0, -1).includes('\n'), false);
  assert.deepEqual(parseJsonLine(line.trim()), value);
});

test('the factories write what the codex dialect writes', () => {
  const codex = (raw: unknown) => codexDialect.parseLine(JSON.stringify(raw));
  assert.deepEqual(
    codex({ type: 'thread.started', thread_id: 'T1' }),
    [systemInitEvent({ sessionId: 'T1', backend: 'codex' })],
  );
  assert.deepEqual(
    codex({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi' } }),
    [assistantTextEvent('hi', 'i1')],
  );
  assert.deepEqual(
    codex({ type: 'item.completed', item: { id: 'i2', type: 'reasoning', text: 'hmm' } }),
    [assistantThinkingEvent('hmm', 'i2')],
  );
  assert.deepEqual(
    codex({ type: 'item.completed', item: { id: 'i3', type: 'command_execution', command: 'ls', aggregated_output: 'a', exit_code: 0, status: 'completed' } }),
    [
      toolUseEvent({ id: 'i3', name: 'bash', input: { command: 'ls' } }),
      toolResultEvent({ toolUseId: 'i3', content: 'a', isError: false }),
    ],
  );
  assert.deepEqual(
    codex({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 3 } }),
    [resultSuccessEvent({ usage: { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 } })],
  );
  assert.deepEqual(
    codex({ type: 'turn.failed', error: { message: 'boom' } }),
    [resultErrorEvent({ error: 'boom' })],
  );
});

test('assistantDeltaEvent is the event the stream-json partial reader writes', () => {
  const line = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bon' } } };
  assert.deepEqual(partialTextDelta(line), [assistantDeltaEvent('Bon')]);
  assert.deepEqual(claudeDialect.parseLine(JSON.stringify(line)), [assistantDeltaEvent('Bon')]);
});

test('streamJsonUser frames a turn as the Claude CLI reads it', () => {
  const plain = streamJsonUser('salut');
  assert.deepEqual(JSON.parse(plain), { type: 'user', message: { role: 'user', content: 'salut' } });
  const withImage = JSON.parse(streamJsonUser('regarde', [{ media_type: 'image/png', data: 'AAAA' }])) as {
    message: { content: Array<{ type: string }> };
  };
  assert.deepEqual(withImage.message.content.map((b) => b.type), ['text', 'image']);
});

test('an error result carries the HTTP status the usage-limit detector reads', () => {
  const hit429 = resultErrorEvent({ error: 'too many requests', apiErrorStatus: 429 });
  assert.equal(rateLimitFromEvent(hit429.type, hit429.payload)?.kind, 'rate_limit');
  const hit402 = resultErrorEvent({ error: 'payment required', apiErrorStatus: 402 });
  assert.equal(rateLimitFromEvent(hit402.type, hit402.payload)?.kind, 'exhausted');
  const plain = resultErrorEvent({ error: 'syntax error in the prompt' });
  assert.equal(rateLimitFromEvent(plain.type, plain.payload), null);
});

test('extractInitSessionId reads the init and nothing else', () => {
  assert.equal(extractInitSessionId(systemInitEvent({ sessionId: 'S' })), 'S');
  assert.equal(extractInitSessionId(systemInitEvent({ sessionId: '' })), null, 'an empty id is no id');
  assert.equal(extractInitSessionId({ type: 'system', payload: { subtype: 'compact' } }), null);
  assert.equal(extractInitSessionId({ type: 'system', payload: null }), null, 'a null payload must not throw');
  assert.equal(extractInitSessionId(assistantTextEvent('x')), null);
  assert.equal(extractInitSessionId(resultSuccessEvent()), null);
});

test('providerRetryEvent is a provider retry, never a result, and reads its kind from the status first', () => {
  const ev = providerRetryEvent({ attempt: 3, max: 5, cause: 'socket hang up', delayMs: 2000.7 });
  assert.equal(ev.type, 'provider_retry');
  assert.deepEqual(ev.payload, {
    type: 'provider_retry', attempt: 3, max: 5, cause: 'socket hang up', delay_ms: 2000, kind: 'transport',
  });
  assert.equal(rateLimitFromEvent(ev.type, ev.payload), null, 'a retry the provider absorbs is no quota wall');
  assert.equal(providerRetryKind('anything', 429), 'rate_limit');
  assert.equal(providerRetryKind('anything', 529), 'overloaded');
  assert.equal(providerRetryKind('anything', 503), 'server');
  assert.equal(providerRetryKind('Overloaded'), 'overloaded');
  assert.equal(providerRetryKind('502 Bad Gateway'), 'server');
  assert.equal(providerRetryKind('websocket closed'), 'transport');
  const unknown = providerRetryEvent({ attempt: -1, max: Number.NaN, cause: 'x', kind: 'server' });
  assert.equal((unknown.payload as { attempt: unknown }).attempt, null);
  assert.equal((unknown.payload as { max: unknown }).max, null);
  assert.equal((unknown.payload as { kind: unknown }).kind, 'server');
});
