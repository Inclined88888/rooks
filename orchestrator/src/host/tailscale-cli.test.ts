/**
 * The environment the tailscale CLI is launched with. Pure: no binary runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tailscaleCliEnv, tailscaleCliOpts } from './tailscale-cli.js';

const APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

test('macOS app bundle CLI started without TERM (launchd) gets TERM=dumb, the rest of the environment kept', () => {
  const env = tailscaleCliEnv(APP_CLI, 'darwin', { PATH: '/usr/bin', HOME: '/Users/robin' });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/Users/robin', TERM: 'dumb' });
});

test('a TERM already set is never replaced', () => {
  assert.equal(tailscaleCliEnv(APP_CLI, 'darwin', { TERM: 'xterm-256color' }), undefined);
});

test('nothing changes outside the macOS app bundle', () => {
  assert.equal(tailscaleCliEnv('/opt/homebrew/bin/tailscale', 'darwin', {}), undefined);
  assert.equal(tailscaleCliEnv('/usr/bin/tailscale', 'linux', {}), undefined);
  assert.equal(tailscaleCliEnv('C:\\Program Files\\Tailscale\\tailscale.exe', 'win32', {}), undefined);
  // A Linux path that happens to contain `.app/` is still Linux.
  assert.equal(tailscaleCliEnv('/srv/tools.app/tailscale', 'linux', {}), undefined);
});

test('exec options: TERM added on top of the given env, options otherwise untouched', () => {
  const opts = tailscaleCliOpts(APP_CLI, { timeout: 10_000, env: { PATH: '/usr/bin' } }, 'darwin');
  assert.deepEqual(opts, { timeout: 10_000, env: { PATH: '/usr/bin', TERM: 'dumb' } });
  const linux = { timeout: 10_000 };
  assert.equal(tailscaleCliOpts('/usr/bin/tailscale', linux, 'linux'), linux);
});
