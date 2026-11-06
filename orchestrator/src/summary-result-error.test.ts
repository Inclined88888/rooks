/**
 * TIM-0064: a summary that failed on the Claude CLI reported "unknown error".
 * The reason lives in a different field for each CLI; every one is read.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resultErrorText, stderrReason } = await import('./summary.js');
const { setRedactionSource } = await import('./secrets/redact.js');

test('a Claude quota result carries its reason in `result`, with its HTTP status', () => {
  const p = { type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
    result: "You've hit your session limit · resets 6:40pm (Europe/Paris)" };
  assert.equal(resultErrorText(p), "You've hit your session limit · resets 6:40pm (Europe/Paris) (HTTP 429)");
});

test('a Claude sign-in failure has no message on its result: the assistant text says why', () => {
  const p = { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error' };
  const said = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  assert.equal(resultErrorText(p, said), said);
  assert.equal(resultErrorText(p), 'api_error', 'without any text, the terminal reason still beats "unknown error"');
});

test('codex/copilot `error` and grok `errors` are read as before', () => {
  assert.equal(resultErrorText({ is_error: true, error: 'turn failed' }), 'turn failed');
  assert.equal(resultErrorText({ is_error: true, errors: ['ENOENT: no such file', 42, ''] }), 'ENOENT: no such file');
});

test('a failure subtype names itself; nothing at all stays "unknown error"', () => {
  assert.equal(resultErrorText({ is_error: true, subtype: 'error_max_turns' }), 'error_max_turns');
  assert.equal(resultErrorText({ is_error: true, subtype: 'success' }), 'unknown error');
  assert.equal(resultErrorText(null), 'unknown error');
});

test('the reason is one bounded line', () => {
  const out = resultErrorText({ is_error: true, result: `line one\n\nline two ${'x'.repeat(1000)}` });
  assert.ok(!out.includes('\n'));
  assert.ok(out.startsWith('line one line two'));
  assert.ok(out.length <= 301);
});

test('a vault secret is masked in the reason and in the stderr tail', () => {
  const SECRET = 'sk-live-0123456789abcdef';
  const previous = setRedactionSource(() => [SECRET]);
  try {
    assert.equal(resultErrorText({ is_error: true, result: `bad key ${SECRET}` }), 'bad key ***');
    const out = stderrReason(`starting\n\u001b[31merror: token ${SECRET} rejected\u001b[0m\n`);
    assert.ok(!out.includes(SECRET));
    assert.match(out, /error: token \*\*\* rejected$/);
  } finally {
    setRedactionSource(previous);
  }
});

test('the stderr tail keeps its END, on one line', () => {
  const out = stderrReason(`${'noise '.repeat(200)}\nError: not signed in\n`);
  assert.ok(out.startsWith('…'));
  assert.ok(out.endsWith('Error: not signed in'));
  assert.ok(out.length <= 301);
});
