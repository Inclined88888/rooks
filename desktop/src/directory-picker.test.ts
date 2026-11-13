import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDirectory } from './directory-picker.js';

const origin = 'http://127.0.0.1:4312';
const sender = { isWindow: true, isMainFrame: true, url: `${origin}/edit` };

test('opens a directory dialog at the current cwd and returns the selected absolute path', async () => {
  const path = '/Users/example/My Project';
  const result = await selectDirectory(sender, origin, '/Users/example', async (options) => {
    assert.deepEqual(options, {
      properties: ['openDirectory', 'createDirectory'], defaultPath: '/Users/example',
    });
    return { canceled: false, filePaths: [path] };
  });
  assert.equal(result, path);
});

test('cancellation and empty selections leave the cwd unchanged', async () => {
  for (const result of [{ canceled: true, filePaths: ['/ignored'] }, { canceled: false, filePaths: [] }]) {
    assert.equal(await selectDirectory(sender, origin, undefined, async () => result), null);
  }
});

test('ignores invalid default paths and propagates dialog failures', async () => {
  for (const path of [undefined, null, {}, 42, 'relative/path']) {
    await selectDirectory(sender, origin, path, async (options) => {
      assert.equal(options.defaultPath, undefined);
      return { canceled: true, filePaths: [] };
    });
  }
  await assert.rejects(selectDirectory(sender, origin, '', async () => { throw new Error('dialog failed'); }), /dialog failed/);
});

test('rejects foreign windows, subframes and origins before opening the dialog', async () => {
  for (const change of [
    { isWindow: false }, { isMainFrame: false }, { url: 'https://example.com/edit' },
    { url: 'http://127.0.0.1:4313/edit' }, { url: 'invalid' }, { url: 'file:///edit' },
  ]) {
    await assert.rejects(selectDirectory({ ...sender, ...change }, origin, '', async () => {
      assert.fail('untrusted sender opened the dialog');
    }), /only available from Rooks/);
  }
});

test('plugin source: a folder picker or a .tgz/.zip picker, from Timon only', async () => {
  const { selectPluginSource } = await import('./directory-picker.js');
  const folder = await selectPluginSource(sender, origin, 'folder', async (options) => {
    assert.deepEqual(options, { properties: ['openDirectory'] });
    return { canceled: false, filePaths: ['/Users/example/Downloads/acme-plugin'] };
  });
  assert.equal(folder, '/Users/example/Downloads/acme-plugin');
  const archive = await selectPluginSource(sender, origin, 'archive', async (options) => {
    assert.deepEqual(options.properties, ['openFile']);
    assert.deepEqual(options.filters?.[0]?.extensions, ['tgz', 'gz', 'zip']);
    return { canceled: false, filePaths: ['/Users/example/acme-1.0.0.tgz'] };
  });
  assert.equal(archive, '/Users/example/acme-1.0.0.tgz');
  assert.equal(await selectPluginSource(sender, origin, 'folder', async () => ({ canceled: true, filePaths: [] })), null);
  for (const kind of ['file', undefined, {}, 'both']) {
    await assert.rejects(selectPluginSource(sender, origin, kind, async () => assert.fail('opened for an unknown kind')), /Unknown plugin source kind/);
  }
  await assert.rejects(selectPluginSource({ ...sender, url: 'https://example.com/plugins' }, origin, 'folder', async () => {
    assert.fail('untrusted sender opened the dialog');
  }), /only available from Rooks/);
});

test('executable: a file picker that shows hidden folders and opens .app bundles, from Timon only', async () => {
  const { selectExecutable } = await import('./directory-picker.js');
  const picked = await selectExecutable(sender, origin, '/Users/example/.local/bin/claude', async (options) => {
    assert.deepEqual(options, {
      properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'],
      defaultPath: '/Users/example/.local/bin/claude',
    });
    return { canceled: false, filePaths: ['/opt/homebrew/bin/claude'] };
  }, 'darwin');
  assert.equal(picked, '/opt/homebrew/bin/claude');
  await selectExecutable(sender, origin, 'relative', async (options) => {
    assert.equal(options.defaultPath, undefined);
    assert.deepEqual(options.filters?.map((f) => f.extensions), [['exe', 'cmd', 'bat'], ['*']]);
    return { canceled: true, filePaths: [] };
  }, 'win32');
  assert.equal(await selectExecutable(sender, origin, undefined, async () => ({ canceled: false, filePaths: ['relative/claude'] }), 'linux'), null);
  assert.equal(await selectExecutable(sender, origin, undefined, async () => ({ canceled: true, filePaths: [] }), 'linux'), null);
  await assert.rejects(selectExecutable({ ...sender, isMainFrame: false }, origin, undefined, async () => {
    assert.fail('untrusted sender opened the dialog');
  }), /only available from Rooks/);
});
