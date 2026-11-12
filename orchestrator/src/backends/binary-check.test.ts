/**
 * The startup check of the backend CLI binaries.
 *
 * What it protects: an install whose CLI is nowhere only discovered it through
 * empty missions (beta tester's Mac mini, 20/09/2026). The check must see the
 * absence, name it, and tell a detected binary from a broken `host.binaries`
 * pin — the two call for a different gesture.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const { checkBackendBinaries, backendBinaryNotice } = await import('./binary-check.js');
const { NovaConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

/** Lookup options of a machine where NOTHING is installed: no PATH, no desktop
 *  app. The verdict then no longer depends on the machine running the test. */
const EMPTY_MACHINE = { path: '', homeDir: join('/', 'nowhere'), env: {} as NodeJS.ProcessEnv };

test('no CLI installed: every backend is reported, once per binary', () => {
  const statuses = checkBackendBinaries(EMPTY_MACHINE);
  assert.ok(statuses.length > 0, 'at least one backend in the catalog');
  assert.ok(statuses.every((s) => s.path === null), 'nothing must resolve here');
  const cmds = statuses.map((s) => s.cmd);
  assert.deepEqual([...new Set(cmds)], cmds, 'one verdict per binary, not per profile');
  assert.ok(statuses.every((s) => s.backends.length > 0), 'every binary names its backends');
});

test('a pinned binary resolves, and the verdict says so', () => {
  const cfg = NovaConfigSchema.parse({});
  const target = checkBackendBinaries(EMPTY_MACHINE)[0];
  // `process.execPath` rather than a real CLI: the verdict must not depend on
  // what happens to be installed on the machine running the test.
  setConfig({ ...cfg, host: { ...cfg.host, binaries: { [target.cmd]: process.execPath } } });
  try {
    const pinned = checkBackendBinaries(EMPTY_MACHINE).find((s) => s.cmd === target.cmd);
    assert.ok(pinned);
    assert.equal(pinned.path, process.execPath);
    assert.equal(pinned.pinned, true);
  } finally {
    resetConfig();
  }
});

test('broken pin: the notice sends you to fix the path, not to reinstall', () => {
  const cfg = NovaConfigSchema.parse({});
  const target = checkBackendBinaries(EMPTY_MACHINE)[0];
  setConfig({ ...cfg, host: { ...cfg.host, binaries: { [target.cmd]: join('/', 'nowhere', target.cmd) } } });
  try {
    const broken = checkBackendBinaries(EMPTY_MACHINE).find((s) => s.cmd === target.cmd);
    assert.ok(broken);
    assert.equal(broken.path, null);
    assert.equal(broken.pinned, true);
    const notice = backendBinaryNotice(broken);
    assert.match(notice.title, new RegExp(target.cmd));
    assert.match(notice.body, new RegExp(`host\\.binaries\\.${target.cmd}`));
    assert.doesNotMatch(notice.body, /^Install it/m);
    // The repair is a screen of the app, not a JSON file to edit (TODO #413).
    assert.match(notice.body, /Settings › AI models › Providers › CLI binaries/);
  } finally {
    resetConfig();
  }
});

test('binary simply absent: the notice says what to install', () => {
  const missing = checkBackendBinaries(EMPTY_MACHINE)[0];
  const notice = backendBinaryNotice(missing);
  assert.match(notice.title, new RegExp(missing.backends[0]));
  assert.match(notice.body, /Action needed/);
  assert.match(notice.body, /Check again/);
  assert.doesNotMatch(notice.body, /undefined/);
});
