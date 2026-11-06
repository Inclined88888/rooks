import assert from 'node:assert/strict';
import test from 'node:test';
import { chromeVersion, desktopUserAgent, mobileUserAgent, userAgentMetadata } from './native-browser-user-agent.js';

const ELECTRON_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Timon/0.1.3 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36';

test('the desktop user agent names neither Electron nor the app', () => {
  const ua = desktopUserAgent(ELECTRON_UA);
  assert.equal(ua, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36');
  assert.equal(desktopUserAgent(ua), ua);
});

test('a user agent without an app token is left alone', () => {
  const plain = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  assert.equal(desktopUserAgent(plain), plain);
});

test('chrome version falls back when the string carries none', () => {
  assert.equal(chromeVersion(ELECTRON_UA), '130.0.6723.191');
  assert.equal(chromeVersion('curl/8'), '130.0.0.0');
  assert.match(mobileUserAgent('130.0.6723.191'), /Chrome\/130\.0\.6723\.191 Mobile Safari/);
});

test('client hints carry no Electron brand and follow the host platform', () => {
  const mac = userAgentMetadata('130.0.6723.191', false, 'darwin', '14.5.0');
  assert.equal(mac.platform, 'macOS');
  assert.equal(mac.platformVersion, '14.5.0');
  assert.ok(mac.brands.every((entry) => !/electron/i.test(entry.brand)));
  assert.equal(mac.brands[0]?.version, '130');
  assert.equal(userAgentMetadata('130.0.0.0', false, 'win32', '10.0.19045').platform, 'Windows');
  assert.equal(userAgentMetadata('130.0.0.0', false, 'linux', '6.14.0').platform, 'Linux');
  const phone = userAgentMetadata('130.0.0.0', true, 'darwin', '14.5.0');
  assert.deepEqual([phone.mobile, phone.platform], [true, 'Android']);
});
