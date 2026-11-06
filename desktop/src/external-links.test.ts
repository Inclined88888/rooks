import assert from 'node:assert/strict';
import { test } from 'node:test';
import { externalUrl, navigationAction } from './external-links.js';

const ORIGIN = 'http://127.0.0.1:3101';

test('the app\'s own pages stay in the window', () => {
  assert.deepEqual(navigationAction(`${ORIGIN}/agents`, ORIGIN), { kind: 'allow' });
  assert.deepEqual(navigationAction(`${ORIGIN}/login?next=%2F`, ORIGIN), { kind: 'allow' });
});

test('a link to another site opens in the system browser instead of replacing the window', () => {
  assert.deepEqual(
    navigationAction('https://github.com/acme/repo/pull/12', ORIGIN),
    { kind: 'external', url: 'https://github.com/acme/repo/pull/12' },
  );
  assert.deepEqual(navigationAction('mailto:hi@example.com', ORIGIN), { kind: 'external', url: 'mailto:hi@example.com' });
});

test('another port or host on the same machine is not the app', () => {
  assert.equal(navigationAction('http://127.0.0.1:3001/api/health', ORIGIN).kind, 'external');
  assert.equal(navigationAction('http://localhost:3101/', ORIGIN).kind, 'external');
});

test('schemes the OS must not be handed are dropped', () => {
  for (const target of ['file:///etc/passwd', 'javascript:alert(1)', 'ms-msdt:/id', 'data:text/html,<b>x</b>', 'not a url']) {
    assert.equal(navigationAction(target, ORIGIN).kind, 'block', target);
    assert.equal(externalUrl(target), null, target);
  }
});

test('before the window has an origin nothing counts as the app', () => {
  assert.equal(navigationAction(`${ORIGIN}/`, '').kind, 'external');
});
