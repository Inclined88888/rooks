import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTurnFailure, isFailedResult, resultFailureText, tallyProviderRetry, transientFailureReply, turnRetryDelayMs,
  turnRetryPrompt, type TurnFailureInput,
} from './turn-retry.js';

const base: TurnFailureInput = {
  error: '', providerRetries: 0, rateLimited: false, authFailed: false, interrupted: false,
};

test('transport failures are transient, whatever the provider', () => {
  for (const error of [
    'stream disconnected before completion: websocket closed by server before response.completed',
    'API Error: Connection error.', 'read ECONNRESET', 'connect ETIMEDOUT 1.2.3.4:443', 'socket hang up',
    'Request timed out.', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
    '502 Bad Gateway', 'fetch failed',
  ]) assert.equal(classifyTurnFailure({ ...base, error }), 'transient', error);
  assert.equal(classifyTurnFailure({ ...base, error: 'boom', apiErrorStatus: 503 }), 'transient');
  assert.equal(classifyTurnFailure({ ...base, error: 'boom', apiErrorStatus: 408 }), 'transient');
});

test('the provider giving up its own retries is transient even when its last words say nothing', () => {
  assert.equal(classifyTurnFailure({ ...base, error: 'turn failed' }), 'fatal');
  assert.equal(classifyTurnFailure({ ...base, error: 'turn failed', providerRetries: 5 }), 'transient');
});

test('quota, authentication, bad requests and our own interruptions are never retried', () => {
  assert.equal(classifyTurnFailure({ ...base, error: 'stream disconnected', rateLimited: true }), 'fatal');
  assert.equal(classifyTurnFailure({ ...base, error: 'stream disconnected', authFailed: true }), 'fatal');
  assert.equal(classifyTurnFailure({ ...base, error: 'stream disconnected', interrupted: true }), 'fatal');
  assert.equal(classifyTurnFailure({ ...base, error: 'boom', apiErrorStatus: 429, providerRetries: 3 }), 'fatal');
  assert.equal(classifyTurnFailure({ ...base, error: 'boom', apiErrorStatus: 401, providerRetries: 3 }), 'fatal');
  for (const error of [
    'unexpected status 401 Unauthorized', 'Invalid API key · Please run /login', 'prompt is too long: 210000 tokens',
    'invalid_request_error: messages.0.content is empty', '403 Forbidden',
  ]) assert.equal(classifyTurnFailure({ ...base, error, providerRetries: 2 }), 'fatal', error);
});

test('a failed result is read wherever the dialect put its words', () => {
  assert.equal(isFailedResult({ type: 'result', is_error: true }), true);
  assert.equal(isFailedResult({ type: 'result', subtype: 'error_during_execution', is_error: false }), true);
  assert.equal(isFailedResult({ type: 'result', subtype: 'success', is_error: false }), false);
  assert.equal(resultFailureText({ error: 'a', result: 'b', errors: ['c', { message: 'd' }] }), 'a — b — c — d');
  assert.equal(resultFailureText(null), '');
});

test('provider retries are tallied with their ceiling and last cause', () => {
  let tally = tallyProviderRetry(undefined, { attempt: 1, max: 5, cause: 'websocket closed', delay_ms: 4000 });
  tally = tallyProviderRetry(tally, { attempt: null, max: null, cause: 'waiting for network', delay_ms: null });
  assert.deepEqual(tally, { count: 2, max: 5, lastCause: 'waiting for network', lastDelayMs: 4000 });
});

test('the backoff doubles and never undercuts the wait the provider announced', () => {
  assert.deepEqual([1, 2, 3].map((n) => turnRetryDelayMs(n, 30_000)), [30_000, 60_000, 120_000]);
  assert.equal(turnRetryDelayMs(1, 30_000, 90_000), 90_000);
  assert.equal(turnRetryDelayMs(1, 30_000, null), 30_000);
});

test('the replay prompt never repeats the request, and the final answer names both layers of retries', () => {
  const prompt = turnRetryPrompt(2, 3, 'stream disconnected');
  assert.match(prompt, /retry 2\/3/);
  assert.match(prompt, /Do not redo/);
  const reply = transientFailureReply({
    cause: 'stream disconnected', provider_retries: 5, provider_max: 5, rooks_retries: 3, rooks_max: 3,
  });
  assert.match(reply, /unreachable \(transient\) after 5 provider retries \+ 3 Rooks retries — retry later/);
  assert.match(transientFailureReply({
    cause: 'x', provider_retries: 1, provider_max: null, rooks_retries: 0, rooks_max: 3,
  }), /after 1 provider retry — retry later/);
});
