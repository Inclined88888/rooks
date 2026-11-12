/**
 * The packaged daemon runs on the Node the package ships (Electron 33's Node 20
 * lacks `node:sqlite`, and the package's Electron no longer runs as Node:
 * RunAsNode fuse off, TODO #764); only the sources keep Electron.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bundledNodeOf, daemonRuntime, withRuntimeEnv } from './daemon-runtime.js';

const resources = join('/opt', 'Rooks', 'resources'); // portability: simulated path

test('a package runs its daemon on the Node it ships, without the Electron flag', () => {
  const runtime = daemonRuntime({ packaged: true, resourcesPath: resources, electronExecPath: '/opt/Rooks/rooks', platform: 'linux', exists: () => true });
  assert.deepEqual(runtime, { execPath: join(resources, 'node', 'node'), env: {} });
  assert.equal(bundledNodeOf(resources, 'win32'), join(resources, 'node', 'node.exe'));
});

test('the sources keep Electron as Node, whether or not a Node sits under resources', () => {
  const electron = { execPath: '/opt/Rooks/rooks', env: { ELECTRON_RUN_AS_NODE: '1' } };
  assert.deepEqual(daemonRuntime({ packaged: false, resourcesPath: resources, electronExecPath: '/opt/Rooks/rooks', exists: () => true }), electron);
  assert.deepEqual(daemonRuntime({ packaged: false, resourcesPath: resources, electronExecPath: '/opt/Rooks/rooks', exists: () => false }), electron);
});

test('a package without its Node refuses, naming the file, instead of falling back to Electron', () => {
  assert.throws(
    () => daemonRuntime({ packaged: true, resourcesPath: resources, electronExecPath: '/opt/Rooks/rooks', platform: 'linux', exists: () => false }),
    { message: new RegExp(`missing: expected at ${join(resources, 'node', 'node').replaceAll('\\', '\\\\')}`) },
  );
});

test('the Electron flag is never inherited by a real Node, whatever its case', () => {
  const env = withRuntimeEnv({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1' }, { execPath: 'node', env: {} });
  assert.deepEqual(env, { PATH: 'p' });
  assert.deepEqual(withRuntimeEnv({ PATH: 'p' }, { execPath: 'e', env: { ELECTRON_RUN_AS_NODE: '1' } }), { PATH: 'p', ELECTRON_RUN_AS_NODE: '1' });
});
