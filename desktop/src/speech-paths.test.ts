import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';
import { hasNonAscii, isSpeechModelsFallbackDir, prepareSpeechModelsDir, sherpaAddonDir, sherpaPackageName, speechModelsDirCandidates, speechModelsDirPlan, speechModelsFallbackDirs } from './speech-paths.js';

test('the models live in the Rooks home when its path is plain', () => {
  assert.deepEqual(speechModelsDirCandidates('/home/zoé/.rooks', 'linux', {}), ['/home/zoé/.rooks/speech/models']);
  assert.deepEqual(speechModelsDirCandidates('C:\\Users\\Zoe\\.rooks', 'win32', {}), ['C:\\Users\\Zoe\\.rooks\\speech\\models']);
});

test('a non-ASCII Windows home falls back to machine-wide ASCII roots, home last', () => {
  const env = { ProgramData: 'C:\\ProgramData', PUBLIC: 'C:\\Users\\Public', ALLUSERSPROFILE: 'C:\\ProgramData', SystemDrive: 'C:' };
  const candidates = speechModelsDirCandidates('C:\\Users\\Zoé\\.rooks', 'win32', env);
  assert.ok(candidates.length >= 3);
  assert.equal(candidates.at(-1), 'C:\\Users\\Zoé\\.rooks\\speech\\models');
  for (const dir of candidates.slice(0, -1)) {
    assert.ok(!hasNonAscii(dir), dir);
    assert.ok(win32.isAbsolute(dir));
    assert.match(dir, /\\Rooks\\speech-models\\[0-9a-f]{16}$/);
  }
  assert.equal(new Set(candidates).size, candidates.length, 'no duplicate');
  assert.ok(candidates[0]?.startsWith('C:\\ProgramData\\'));
  // Two homes never share a cache.
  const other = speechModelsDirCandidates('C:\\Users\\Zoé\\autre', 'win32', env);
  assert.notEqual(other[0], candidates[0]);
  // A non-ASCII root is skipped.
  const skipped = speechModelsDirCandidates('C:\\Users\\Zoé\\.rooks', 'win32', { ProgramData: 'D:\\Données' });
  assert.deepEqual(skipped, ['C:\\Users\\Zoé\\.rooks\\speech\\models']);
});

test('the first directory that can be prepared wins', async () => {
  const tried: string[] = [];
  const logs: string[] = [];
  const dir = await prepareSpeechModelsDir(['A', 'B', 'C'], async (d) => { tried.push(d); if (d === 'A') throw new Error('EACCES'); }, (line) => logs.push(line));
  assert.equal(dir, 'B');
  assert.deepEqual(tried, ['A', 'B']);
  assert.deepEqual(logs, ['[speech] models folder A skipped: EACCES']);
  await assert.rejects(prepareSpeechModelsDir(['A'], () => { throw new Error('EACCES'); }), /EACCES/);
});

test('only the machine-wide fallbacks are marked shared, with the root they hang from', () => {
  const env = { ProgramData: 'C:\\ProgramData', PUBLIC: 'C:\\Users\\Public' };
  const plan = speechModelsDirPlan('C:\\Users\\Zoé\\.rooks', 'win32', env);
  assert.deepEqual(plan.map((c) => c.shared?.root ?? null), ['C:\\ProgramData', 'C:\\Users\\Public\\Documents', null]);
  assert.deepEqual(plan.map((c) => c.dir), speechModelsDirCandidates('C:\\Users\\Zoé\\.rooks', 'win32', env));
  assert.deepEqual(speechModelsDirPlan('/home/zoé/.rooks', 'linux', env), [{ dir: '/home/zoé/.rooks/speech/models', shared: null }]);
});

test('TODO #444: uninstall recomputes the machine-wide folders from the home, never outside Windows', () => {
  const env = { ProgramData: 'C:\\ProgramData', PUBLIC: 'C:\\Users\\Public' };
  const dirs = speechModelsFallbackDirs('C:\\Users\\Zoé\\.rooks', 'win32', env);
  assert.deepEqual(dirs, speechModelsDirCandidates('C:\\Users\\Zoé\\.rooks', 'win32', env).slice(0, -1));
  assert.equal(dirs.length, 2);
  assert.ok(dirs[1]?.startsWith('C:\\Users\\Public\\Documents\\Rooks\\speech-models\\'));
  assert.deepEqual(speechModelsFallbackDirs('C:\\Users\\Zoe\\.rooks', 'win32', env), []);
  assert.deepEqual(speechModelsFallbackDirs('/home/zoé/.rooks', 'linux', env), []);
  assert.deepEqual(speechModelsFallbackDirs('/Users/zoé/.rooks', 'darwin', env), []);
  // A UNC root is accepted for dictation but never deleted at uninstall.
  assert.deepEqual(speechModelsFallbackDirs('C:\\Users\\Zoé\\.rooks', 'win32', { ProgramData: '\\\\server\\share' }), []);
});

test('TODO #444: only the exact shape of a models fallback folder may be deleted', () => {
  const hex = '0123456789abcdef';
  assert.equal(isSpeechModelsFallbackDir(`C:\\ProgramData\\Rooks\\speech-models\\${hex}`), true);
  assert.equal(isSpeechModelsFallbackDir(`D:\\Users\\Public\\Documents\\Rooks\\speech-models\\${hex}`), true);
  for (const trap of [
    'C:\\', 'C:\\ProgramData', 'C:\\ProgramData\\Rooks', 'C:\\ProgramData\\Rooks\\speech-models',
    `C:\\ProgramData\\Rooks\\speech-models\\${hex}\\`, `C:\\ProgramData\\Rooks\\speech-models\\${hex}0`,
    `C:\\ProgramData\\Rooks\\speech-models\\${hex.toUpperCase()}`, `C:\\ProgramData\\Rooks\\speech-models\\${hex.slice(1)}`,
    `C:\\ProgramData\\Rooks\\speech-models\\${hex}\\..`, `C:\\ProgramData\\..\\Rooks\\speech-models\\${hex}`,
    `C:\\ProgramData\\.\\Rooks\\speech-models\\${hex}`, `C:\\ProgramData\\\\Rooks\\speech-models\\${hex}`,
    `C:/ProgramData/Rooks/speech-models/${hex}`, `C:\\ProgramData/Rooks\\speech-models\\${hex}`,
    `\\\\server\\share\\Rooks\\speech-models\\${hex}`, `Rooks\\speech-models\\${hex}`,
    `/home/zoé/.rooks/Rooks\\speech-models\\${hex}`, `C:\\ProgramData\\Rooks\\speech-models\\other\\${hex}x`,
  ]) assert.equal(isSpeechModelsFallbackDir(trap), false, trap);
});

test('one recognizer package per supported OS and CPU', () => {
  assert.equal(sherpaPackageName('linux', 'x64'), 'sherpa-onnx-linux-x64');
  assert.equal(sherpaPackageName('linux', 'arm64'), 'sherpa-onnx-linux-arm64');
  assert.equal(sherpaPackageName('darwin', 'arm64'), 'sherpa-onnx-darwin-arm64');
  assert.equal(sherpaPackageName('darwin', 'x64'), 'sherpa-onnx-darwin-x64');
  assert.equal(sherpaPackageName('win32', 'x64'), 'sherpa-onnx-win-x64');
  assert.equal(sherpaPackageName('win32', 'arm64'), null);
  assert.equal(sherpaPackageName('freebsd', 'x64'), null);
});

test('the packaged addon is read from app.asar.unpacked, and only when present', () => {
  const base = { platform: 'darwin' as const, arch: 'arm64', packaged: true, resolvePackage: () => { throw new Error('no'); } };
  const expected = posix.join('/Applications/Rooks.app/Contents/Resources', 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-darwin-arm64');
  assert.equal(sherpaAddonDir({ ...base, resourcesPath: '/Applications/Rooks.app/Contents/Resources', exists: (p) => p === posix.join(expected, 'sherpa-onnx.node') }), expected);
  assert.equal(sherpaAddonDir({ ...base, resourcesPath: '/Applications/Rooks.app/Contents/Resources', exists: () => false }), null);
  assert.equal(sherpaAddonDir({ ...base, resourcesPath: undefined, exists: () => true }), null);
  const win = sherpaAddonDir({ platform: 'win32', arch: 'x64', packaged: true, resourcesPath: 'C:\\Program Files\\Rooks\\resources', resolvePackage: () => '', exists: () => true });
  assert.equal(win, 'C:\\Program Files\\Rooks\\resources\\app.asar.unpacked\\node_modules\\sherpa-onnx-win-x64');
});

test('a source checkout resolves the installed package, and has no addon when it is not installed', () => {
  const dev = { platform: 'linux' as const, arch: 'x64', packaged: false, resourcesPath: undefined };
  assert.equal(sherpaAddonDir({ ...dev, resolvePackage: () => '/repo/desktop/node_modules/sherpa-onnx-linux-x64/index.js', exists: () => true }), '/repo/desktop/node_modules/sherpa-onnx-linux-x64');
  assert.equal(sherpaAddonDir({ ...dev, resolvePackage: () => { throw new Error('MODULE_NOT_FOUND'); }, exists: () => true }), null);
  assert.equal(sherpaAddonDir({ ...dev, arch: 'ia32', resolvePackage: () => '/x/index.js', exists: () => true }), null);
});
