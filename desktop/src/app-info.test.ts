import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReadAppInfo } from './app-info.js';

const origin = 'http://127.0.0.1:3110';

test('app info: the main frame of the Rooks window, whatever Settings tab is open', () => {
  const sender = { isWindow: true, isMainFrame: true, url: `${origin}/?settings=system/installation` };
  assert.equal(canReadAppInfo(sender, origin), true);
  assert.equal(canReadAppInfo({ ...sender, url: `${origin}/?settings=system` }, origin), true);
  for (const change of [{ isWindow: false }, { isMainFrame: false }, { url: 'https://evil.example/?settings=system' }, { url: 'not a url' }]) {
    assert.equal(canReadAppInfo({ ...sender, ...change }, origin), false);
  }
});
