import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLocale } from '@/lib/i18n';
import '@/lib/i18n-test-locales';
import { cwdValue } from './cwd-value';

const none = { cwd_path: null, cwd_error: null, cwd_code: null } as const;

test('TIM-0083: the card says why, with the registered path, in both languages', () => {
  const path = '/Users/robin/Documents/acme';
  for (const locale of ['en', 'fr'] as const) {
    setLocale(locale);
    const missing = cwdValue({ cwd_path: path, cwd_error: 'missing', cwd_code: 'ENOENT' });
    const denied = cwdValue({ cwd_path: path, cwd_error: 'denied', cwd_code: 'EPERM' });
    const file = cwdValue({ cwd_path: path, cwd_error: 'not-a-directory', cwd_code: 'NOT_A_DIRECTORY' });
    for (const line of [missing, denied, file]) {
      assert.ok(line.includes(path), `${locale}: the path is shown`);
      assert.ok(!line.startsWith('agentsGrid.'), `${locale}: key is translated`);
    }
    assert.ok(denied.includes('EPERM'), `${locale}: the errno is shown`);
    assert.equal(new Set([missing, denied, file]).size, 3, `${locale}: three distinct reasons`);
  }
  setLocale('en');
});

test('TIM-0083: "no working directory" only when none is registered', () => {
  setLocale('en');
  assert.equal(cwdValue(none), 'no working directory');
  assert.equal(cwdValue(null), 'no working directory');
});
