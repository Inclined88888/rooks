/**
 * One line per series of provider retries, updated in place (TODO #459): the
 * attempt in flight, then how the series ended.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lineOnAbandoned, lineOnOutput, lineOnProviderRetry, lineOnReplayStarted, lineOnResult, retryLineOpen, retryLineText,
} from './provider-retry-line';
import { setLocale } from './i18n';
import './i18n-test-locales';

const retry = (attempt: number | null, max: number | null, cause = 'websocket closed') =>
  ({ type: 'provider_retry', attempt, max, cause, delay_ms: null, kind: 'transport' });

test('each provider attempt updates the same line, and a success recovers it', () => {
  setLocale('en');
  let line = lineOnProviderRetry(null, retry(1, 5), 'codex');
  line = lineOnProviderRetry(line, retry(2, 5), 'codex');
  assert.equal(line.providerRetries, 2);
  const { title, detail } = retryLineText(line);
  assert.equal(title, "Can't reach codex servers — retrying (2/5)…");
  assert.equal(detail, 'websocket closed');
  const recovered = lineOnResult(line, { type: 'result', is_error: false }, 'codex');
  assert.equal(recovered?.state, 'recovered');
  assert.equal(retryLineText(recovered!).title, 'Reconnected after 2 retries');
  assert.equal(retryLineOpen(recovered), false, 'the next retry opens a new line');
});

test('the agent speaking again recovers the series before the turn ends', () => {
  setLocale('en');
  const line = lineOnProviderRetry(null, retry(null, null, 'waiting for network'), 'codex');
  assert.equal(retryLineText(line).title, "Can't reach codex servers — retrying…");
  assert.equal(retryLineText(lineOnOutput(line)!).title, 'Reconnected after 1 retry');
  assert.equal(lineOnOutput(null), null);
});

test('a Rooks replay shows its countdown, then its run; exhaustion names both layers', () => {
  setLocale('en');
  const line = lineOnProviderRetry(null, retry(5, 5), 'Codex');
  const failure = { cause: 'stream disconnected', provider_retries: 5, provider_max: 5, rooks_retries: 0, rooks_max: 3 };
  const replay = lineOnResult(line, { is_error: true, transient_failure: failure, rooks_retry: { attempt: 1, max: 3, delay_ms: 30000 } }, 'Codex')!;
  assert.equal(replay.state, 'replaying');
  assert.equal(retryLineText(replay).title, 'Rooks retry 1/3 in 30s…');
  const running = lineOnReplayStarted(replay, 1, 'Codex');
  assert.equal(retryLineText(running).title, 'Rooks retry 1/3…');
  const exhausted = lineOnResult(running, { is_error: true, transient_failure: { ...failure, rooks_retries: 3 } }, 'Codex')!;
  assert.equal(exhausted.state, 'exhausted');
  assert.equal(retryLineText(exhausted).title, 'Codex servers unreachable after 5 provider retries and 3 Rooks retries');
});

test('a human chat ends on the provider exhaustion line', () => {
  setLocale('en');
  const failure = { cause: 'API Error: Connection error.', provider_retries: 10, provider_max: 10, rooks_retries: 0, rooks_max: 0 };
  const line = lineOnResult(null, { is_error: true, transient_failure: failure }, 'Claude')!;
  assert.equal(retryLineText(line).title, 'Claude servers unreachable after 10 retries');
  assert.equal(retryLineText(line).detail, 'API Error: Connection error.');
});

test('a plain failure is not a retry line, and an abandoned replay ends the series', () => {
  setLocale('en');
  assert.equal(lineOnResult(null, { is_error: true, error: 'boom' }, 'codex'), null);
  const replay = lineOnReplayStarted(null, 2, 'codex');
  const ended = lineOnAbandoned(replay, { reason: 'stopped by the user' }, 'codex');
  assert.equal(ended.state, 'exhausted');
  assert.equal(ended.rooksRetries, 1);
});

test('the lines follow the locale', () => {
  setLocale('fr');
  try {
    const line = lineOnProviderRetry(null, retry(2, 5), 'codex');
    assert.equal(retryLineText(line).title, 'Serveurs codex injoignables — nouvel essai (2/5)…');
  } finally {
    setLocale('en');
  }
});
