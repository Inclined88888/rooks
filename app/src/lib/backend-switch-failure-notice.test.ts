import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendSwitchFailureNotice } from './backend-switch-failure-notice';

test('says what failed, why, and where the conversation stayed', () => {
  const notice = backendSwitchFailureNotice({
    backend: 'codex', model: 'gpt-5.5', previous_backend: 'claude@abc', reason: 'spawn codex ENOENT.',
  });
  assert.match(notice, /claude@abc/);
  assert.match(notice, /codex · gpt-5\.5/);
  assert.match(notice, /spawn codex ENOENT\./);
  assert.doesNotMatch(notice, /ENOENT\.\./);
});

test('a reason is one bounded line, and a torn payload still reads', () => {
  const notice = backendSwitchFailureNotice({ backend: 'codex', previous_backend: 'claude', reason: `line one\nline two ${'a'.repeat(2000)}` });
  assert.match(notice, /line one line two/);
  assert.ok(notice.length < 700);
  assert.match(backendSwitchFailureNotice({}), /\?/);
});
