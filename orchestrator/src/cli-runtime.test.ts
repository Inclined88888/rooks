/**
 * Tester report (27/09/2026): the packaged CLI crashed when the system Node
 * ran it, its native modules being built for the app's Electron. The service
 * puts `<installDir>/bin` on every agent's PATH, so `timon` got there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { packagedLauncher } from '../bin/cli-runtime.mjs';

const linuxBin = join('/opt', 'Timon', 'resources', 'orchestrator', 'bin', 'timon');
const macBin = join('/Applications', 'Timon.app', 'Contents', 'Resources', 'orchestrator', 'bin', 'timon');
const node = { node: '24.19.0' };

test('a packaged CLI run by the system Node goes back through the package launcher', () => {
  const seen: string[] = [];
  const exists = (file: string) => { seen.push(file); return true; };
  assert.equal(packagedLauncher(linuxBin, { versions: node, env: {}, platform: 'linux', exists }), join('/opt', 'Timon', 'cli', 'timon'));
  assert.equal(packagedLauncher(macBin, { versions: node, env: {}, platform: 'darwin', exists }),
    join('/Applications', 'Timon.app', 'Contents', 'cli', 'timon'));
  assert.equal(seen.length, 2);
});

test('the app runtime, a source checkout, Windows and a relaunch keep the current process', () => {
  const always = () => true;
  assert.equal(packagedLauncher(linuxBin, { versions: { ...node, electron: '38.0.0' }, env: {}, platform: 'linux', exists: always }), null);
  assert.equal(packagedLauncher(linuxBin, { versions: node, env: { TIMON_CLI_REEXEC: '1' }, platform: 'linux', exists: always }), null);
  assert.equal(packagedLauncher(linuxBin, { versions: node, env: {}, platform: 'win32', exists: always }), null);
  const checkout = join('/home', 'sam', 'timon', 'orchestrator', 'bin', 'timon');
  assert.equal(packagedLauncher(checkout, { versions: node, env: {}, platform: 'linux', exists: () => false }), null);
});

test('the Node the package ships keeps the current process: the launcher would only start it again', () => {
  const always = () => true;
  const shipped = join('/opt', 'Timon', 'resources', 'node', 'node'); // portability: simulated path
  assert.equal(packagedLauncher(linuxBin, { versions: node, env: {}, platform: 'linux', exists: always, execPath: shipped }), null);
});
