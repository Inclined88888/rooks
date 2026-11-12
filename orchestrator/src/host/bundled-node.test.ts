/**
 * The packaged daemon moves from Electron run as Node to the Node the package
 * ships (TODO #463): every "am I a package" check read `versions.electron`
 * and would have answered no.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBundledNode, packagedRuntime } from './bundled-node.js';
import { nodeRuntime } from './node-runtime.js';
import { isBundledNode as launcherCopy } from '../../bin/cli-runtime.mjs';
import type { NovaConfig } from '../config/schema.js';

const node = { ...process.versions, electron: undefined } as unknown as NodeJS.ProcessVersions;
const electron = { ...process.versions, electron: '33.4.11' } as NodeJS.ProcessVersions;

// portability: simulated paths of each OS, never touched on disk
const shipped: Array<[string, NodeJS.Platform]> = [
  ['/opt/Rooks/resources/node/node', 'linux'],
  ['/home/sam/.rooks/desktop-runtime/releases/0.1.7/resources/node/node', 'linux'],
  ['/Applications/Rooks.app/Contents/Resources/node/node', 'darwin'],
  ['C:\\Users\\Sam\\AppData\\Local\\Programs\\Rooks\\resources\\node\\node.exe', 'win32'],
];
const system: Array<[string, NodeJS.Platform]> = [
  ['/usr/bin/node', 'linux'],
  ['/home/sam/.nvm/versions/node/v22.23.4/bin/node', 'linux'],
  ['/opt/homebrew/bin/node', 'darwin'],
  ['C:\\Program Files\\nodejs\\node.exe', 'win32'],
  ['/opt/Rooks/resources/node/node.exe', 'linux'],
  ['/Applications/Rooks.app/Contents/MacOS/Rooks', 'darwin'],
];

test('the Node a package ships is recognised on each OS, a system Node is not', () => {
  for (const [path, platform] of shipped) assert.equal(isBundledNode(path, platform), true, path);
  for (const [path, platform] of system) assert.equal(isBundledNode(path, platform), false, path);
});

test('the CLI launcher keeps the same copy of the check', () => {
  for (const [path, platform] of [...shipped, ...system]) assert.equal(launcherCopy(path, platform), isBundledNode(path, platform), path);
});

test('a package is its Electron runtime or its shipped Node, never a source checkout', () => {
  assert.equal(packagedRuntime({ execPath: '/opt/Rooks/rooks', versions: electron, platform: 'linux' }), true);
  assert.equal(packagedRuntime({ execPath: '/opt/Rooks/resources/node/node', versions: node, platform: 'linux' }), true);
  assert.equal(packagedRuntime({ execPath: '/usr/bin/node', versions: node, platform: 'linux' }), false);
});

test('a child of the shipped Node runs on it, without the Electron flag', () => {
  // nodeRuntime reads only the pinned binary; none pinned here.
  const cfg = { host: { binaries: {} } } as unknown as NovaConfig;
  const execPath = '/opt/Rooks/resources/node/node';
  assert.deepEqual(nodeRuntime(cfg, { execPath, platform: 'linux' }), { command: execPath, env: {} });
  assert.deepEqual(nodeRuntime(cfg, { execPath: '/opt/Rooks/rooks', electron: '33.4.11', platform: 'linux' }),
    { command: '/opt/Rooks/rooks', env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.deepEqual(nodeRuntime(cfg, { execPath: '/usr/bin/node', platform: 'linux' }), { command: 'node', env: {} });
});

test('a service of the shipped Node runs it, staged inside the release, without the Electron flag', async () => {
  const { packagedServiceOptions } = await import('./packaged-service.js');
  const base = { platform: 'linux', homeDir: '/home/sam', novaHome: '/home/sam/.rooks', installDir: '/opt/Rooks/resources/orchestrator',
    userName: 'sam', uid: 1000, heapMb: 512, port: 3010, nodePath: '/opt/Rooks/resources/node/node' } as unknown as import('./service-install.js').ServiceOpts;
  const linux = packagedServiceOptions(base, '/opt/Rooks/resources/node/node', 3110, '0.1.7');
  assert.match(linux.nodePath, /desktop-runtime[\\/]releases[\\/][^\\/]+[\\/]resources[\\/]node[\\/]node$/);
  assert.equal(linux.environment?.ELECTRON_RUN_AS_NODE, undefined);
  assert.match(linux.unitContent ?? '', /resources\/node\/node" --max-old-space-size=512/);
  const mac = packagedServiceOptions({ ...base, platform: 'darwin' }, '/Applications/Rooks.app/Contents/Resources/node/node', 3110, '0.1.7');
  assert.match(mac.nodePath, /Rooks\.app[\\/]Contents[\\/]Resources[\\/]node[\\/]node$/, 'the staged copy keeps the bundle name');
  assert.match(mac.installDir, /Rooks\.app[\\/]Contents[\\/]Resources[\\/]orchestrator$/);
  // A package before its Node travelled keeps Electron as Node.
  const electron = packagedServiceOptions(base, '/opt/Rooks/rooks-desktop', 3110, '0.1.7');
  assert.equal(electron.environment?.ELECTRON_RUN_AS_NODE, '1');
});

test('the Windows launcher and the update runner set the Electron flag only for Electron', async () => {
  const { renderWindowsLauncher } = await import('./service-install.js');
  const opts = { novaHome: 'C:\\Users\\Sam\\.rooks', installDir: 'C:\\Programs\\Rooks\\resources\\orchestrator', heapMb: 512, port: 3010 };
  assert.doesNotMatch(renderWindowsLauncher({ ...opts, nodePath: 'C:\\Programs\\Rooks\\resources\\node\\node.exe' }), /ELECTRON_RUN_AS_NODE/);
  assert.match(renderWindowsLauncher({ ...opts, nodePath: 'C:\\Programs\\Rooks\\Rooks.exe' }), /set "ELECTRON_RUN_AS_NODE=1"/);
  const { runnerEnvironment } = await import('./packaged-apply.js');
  const input = { platform: 'linux' as const, home: '/h', cliVersion: '0.1.7', installDir: '/opt/Rooks/resources/orchestrator',
    daemonPort: 3010, appEnabled: true, appPort: 3110, path: undefined, now: 0 };
  assert.equal(runnerEnvironment({ ...input, execPath: '/opt/Rooks/resources/node/node' }).ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(runnerEnvironment({ ...input, execPath: '/opt/Rooks/rooks-desktop' }).ELECTRON_RUN_AS_NODE, '1');
});
