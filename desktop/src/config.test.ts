import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daemonEnvOverrides,
  loadDesktopConfig,
  originOf,
  resolveTimonHome,
  expandTilde,
  PACKAGED_DEFAULTS,
} from './config.js';

function home(content?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'timon-desktop-test-'));
  if (content !== undefined) {
    writeFileSync(join(dir, 'timon.config.json'), JSON.stringify(content), 'utf8');
  }
  return dir;
}

test('a missing config file gives the schema defaults', () => {
  const cfg = loadDesktopConfig(home());
  assert.deepEqual(cfg.daemon.listen, { host: '127.0.0.1', port: 3000 });
  assert.deepEqual(cfg.app.listen, { host: '127.0.0.1', port: 3100 });
  assert.equal(cfg.daemon.supervisor, 'systemd-user');
  assert.equal(cfg.daemon.heapMb, 4096);
  assert.equal(cfg.app.enabled, false);
});

test('user keys win, unset keys keep their default', () => {
  const cfg = loadDesktopConfig(home({
    daemon: { listen: { port: 3999 }, supervisor: 'none', heapMb: 2048 },
    app: { enabled: true, listen: { host: '0.0.0.0', port: 4100 } },
  }));
  assert.deepEqual(cfg.daemon.listen, { host: '127.0.0.1', port: 3999 });
  assert.equal(cfg.daemon.supervisor, 'none');
  assert.equal(cfg.daemon.heapMb, 2048);
  assert.equal(cfg.app.enabled, true);
  assert.deepEqual(cfg.app.listen, { host: '0.0.0.0', port: 4100 });
});

test('a broken config file still opens the window on the defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-desktop-test-'));
  writeFileSync(join(dir, 'timon.config.json'), '{ this is not json', 'utf8');
  const cfg = loadDesktopConfig(dir);
  assert.equal(cfg.daemon.listen.port, 3000);
});

test('nonsense values fall back instead of propagating', () => {
  const cfg = loadDesktopConfig(home({
    daemon: { listen: { port: 'nope' }, supervisor: 'sysvinit', heapMb: -1 },
    app: { enabled: 'yes' },
  }));
  assert.equal(cfg.daemon.listen.port, 3000);
  assert.equal(cfg.daemon.supervisor, 'systemd-user');
  assert.equal(cfg.daemon.heapMb, 4096);
  assert.equal(cfg.app.enabled, false);
});

test('installDir expands a leading tilde', () => {
  const cfg = loadDesktopConfig(home({ daemon: { installDir: '~/timon/orchestrator' } }));
  assert.ok(cfg.daemon.installDir.startsWith('/'));
  assert.ok(cfg.daemon.installDir.endsWith('/timon/orchestrator'));
  assert.equal(expandTilde('/abs/path'), '/abs/path');
});

test('TIMON_HOME wins over the real home', () => {
  assert.equal(resolveTimonHome({ TIMON_HOME: '/tmp/elsewhere' }), '/tmp/elsewhere');
  assert.ok(resolveTimonHome({}).endsWith('/.timon'));
  assert.ok(resolveTimonHome({ TIMON_HOME: '' }).endsWith('/.timon'));
});

test('a wildcard listen address is dialled back to the loopback', () => {
  assert.equal(originOf({ host: '0.0.0.0', port: 3100 }), 'http://127.0.0.1:3100');
  assert.equal(originOf({ host: '::', port: 3100 }), 'http://127.0.0.1:3100');
  assert.equal(originOf({ host: '192.168.1.4', port: 3000 }), 'http://192.168.1.4:3000');
});

/**
 * First launch of an INSTALLED package (step 5.6.3).
 *
 * The daemon's defaults describe a developer machine, and every one of them
 * fails silently on a fresh installation: nothing supervises the daemon, no UI
 * is served, and :3000 may be another program's — the probe succeeds, the shell
 * opens a window on :3100, and the user gets a blank page with no message.
 */
test('an installed package with no config file starts portable and serves its UI', () => {
  const cfg = loadDesktopConfig(home(), { packaged: true });
  assert.equal(cfg.daemon.supervisor, 'none', 'nothing else would start the daemon');
  assert.equal(cfg.app.enabled, true, 'there is no Compose next to a package');
  assert.equal(cfg.packagedDefaults, true);
  // Neither the v1 (:3000/:3100) nor the Timon dev home (:3001/:3101).
  assert.deepEqual(cfg.daemon.listen, { host: '127.0.0.1', port: 3010 });
  assert.deepEqual(cfg.app.listen, { host: '127.0.0.1', port: 3110 });
  for (const taken of [3000, 3100, 3001, 3101]) {
    assert.notEqual(cfg.daemon.listen.port, taken);
    assert.notEqual(cfg.app.listen.port, taken);
  }
  assert.equal(PACKAGED_DEFAULTS.daemon.listen.port, 3010);
});

test('a config file is the authority, even in a package', () => {
  const cfg = loadDesktopConfig(home({ daemon: { listen: { port: 3000 }, supervisor: 'systemd-user' } }), { packaged: true });
  assert.equal(cfg.daemon.listen.port, 3000);
  assert.equal(cfg.daemon.supervisor, 'systemd-user');
  assert.equal(cfg.packagedDefaults, false);
  assert.deepEqual(daemonEnvOverrides(cfg), {}, 'the file speaks for the daemon, not us');
});

test('the shell tells the daemon the defaults it chose alone', () => {
  const overrides = daemonEnvOverrides(loadDesktopConfig(home(), { packaged: true }));
  assert.deepEqual(overrides, { PORT: '3010', TIMON_APP_ENABLED: '1', TIMON_APP_PORT: '3110' });
});

test('a development shell keeps the daemon defaults', () => {
  const cfg = loadDesktopConfig(home(), { packaged: false });
  assert.equal(cfg.daemon.listen.port, 3000);
  assert.equal(cfg.packagedDefaults, false);
  assert.deepEqual(daemonEnvOverrides(cfg), {});
});
