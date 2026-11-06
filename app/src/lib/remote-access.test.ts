import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteAccessCommands, type AppListener } from './remote-access';
import en from '../locales/en/setup.json';
import fr from '../locales/fr/setup.json';

const APP = { servedByDaemon: true, host: '127.0.0.1', port: 3101 };

/** What the network may really send, whatever the type says. */
const untyped = (value: unknown) => remoteAccessCommands(value as Partial<AppListener>);

test('the daemon listener supplies the command, regardless of the browser origin', () => {
  assert.deepEqual(remoteAccessCommands(APP), {
    up: 'tailscale up', serve: 'tailscale serve --bg --https=443 http://127.0.0.1:3101',
  });
  assert.equal(remoteAccessCommands({ ...APP, port: 8080 }).serve,
    'tailscale serve --bg --https=443 http://127.0.0.1:8080');
});

test('external hosting never uses the disabled app configuration or browser URL', () => {
  assert.equal(remoteAccessCommands({ ...APP, servedByDaemon: false }).serve, null);
  for (const value of [null, undefined, {}, 'https://timon.localhost', 'http://localhost:3100']) {
    assert.equal(untyped(value).serve, null);
  }
});

test('invalid ports and unverified hosts never become shell command arguments', () => {
  for (const port of [0, 65536, 3.5, NaN, Infinity, '3100', '3100;rm -rf /']) {
    assert.equal(untyped({ ...APP, port }).serve, null);
  }
  for (const host of ['localhost', '192.168.1.20', 'evil;command', undefined]) {
    assert.equal(untyped({ ...APP, host }).serve, null);
  }
  for (const host of ['::1', '::']) {
    assert.equal(remoteAccessCommands({ ...APP, host }).serve,
      'tailscale serve --bg --https=443 http://[::1]:3101');
  }
  assert.equal(remoteAccessCommands({ ...APP, host: '0.0.0.0' }).serve,
    'tailscale serve --bg --https=443 http://127.0.0.1:3101');
});

test('both locales carry every key the remote-access panel renders', () => {
  const keys = [
    'remoteAccess', 'remoteAccessIntro', 'remoteAccessAppTitle', 'remoteAccessAppHint',
    'remoteAccessCliTitle', 'remoteAccessCliHint', 'remoteAccessCommandLabel', 'remoteAccessConsoleHint', 'remoteAccessDownload', 'remoteAccessTargetLoading', 'remoteAccessTargetUnknown',
  ];
  for (const locale of [{ name: 'en', dict: en }, { name: 'fr', dict: fr }]) {
    const page = (locale.dict as { setupPage: Record<string, string> }).setupPage;
    for (const key of keys) {
      const value = page[key];
      assert.equal(typeof value, 'string', `${locale.name}: setupPage.${key}`);
      assert.notEqual(value!.trim(), '', `${locale.name}: setupPage.${key} is empty`);
    }
  }
});
