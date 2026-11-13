/**
 * The private folder a provider keeps its per-mission state in: containment,
 * modes, the reference swap, and the link chain a credential file taught us.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createScratchDir, ScratchPathError, MAX_SCRATCH_FILE_BYTES } = await import('./scratch-dir.js');

const tmp = (): string => mkdtempSync(join(tmpdir(), 'rooks-scratch-test-'));
const posix = process.platform !== 'win32';

test('files are written inside the folder, 0600 in a 0700 folder, parents created', () => {
  const dir = createScratchDir({ root: join(tmp(), 'm1') });
  const file = dir.writeFile('rules/rooks.md', 'system prompt');
  assert.equal(file, join(dir.path, 'rules', 'rooks.md'));
  assert.equal(readFileSync(file, 'utf8'), 'system prompt');
  if (posix) {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir.path).mode & 0o777, 0o700);
  }
  assert.equal(dir.has('rules/rooks.md'), true);
  dir.remove('rules');
  assert.equal(dir.has('rules/rooks.md'), false);
});

test('a name that leaves the folder is refused: absolute, `..`, a drive, NUL', () => {
  const dir = createScratchDir({ root: join(tmp(), 'm2') });
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'C:\\x', '', 'a\0b', '\\\\server\\share']) {
    assert.throws(() => dir.writeFile(bad, 'x'), ScratchPathError, JSON.stringify(bad));
    assert.throws(() => dir.resolve(bad), ScratchPathError);
  }
});

test('a link inside the folder that leads outside is never written through', () => {
  if (!posix) return;
  const outside = tmp();
  const dir = createScratchDir({ root: join(tmp(), 'm3') });
  symlinkSync(outside, join(dir.path, 'escape'));
  assert.throws(() => dir.writeFile('escape/stolen', 'x'), /leads outside/);
  // A dangling-or-valid link AT the destination is replaced, not followed.
  const target = join(outside, 'victim');
  writeFileSync(target, 'untouched');
  symlinkSync(target, join(dir.path, 'config.toml'));
  dir.writeFile('config.toml', 'mine');
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
  assert.equal(readFileSync(join(dir.path, 'config.toml'), 'utf8'), 'mine');
  assert.equal(lstatSync(join(dir.path, 'config.toml')).isSymbolicLink(), false);
});

test('text goes through the swap with the escape its extension implies; bytes are left alone', () => {
  const calls: Array<[string, string]> = [];
  const dir = createScratchDir({ root: join(tmp(), 'm4'), swap: (text, escape) => { calls.push([text, escape]); return text.replace('REF', 'VALUE'); } });
  dir.writeFile('mcp.json', '{"k":"REF"}');
  dir.writeFile('config.toml', 'k = "REF"');
  dir.writeFile('rules.md', 'REF');
  dir.writeFile('forced.md', 'REF', { escape: 'json' });
  dir.writeFile('image.bin', new Uint8Array([82, 69, 70]));
  assert.deepEqual(calls.map(([, escape]) => escape), ['json', 'json', 'none', 'json']);
  assert.equal(readFileSync(dir.resolve('mcp.json'), 'utf8'), '{"k":"VALUE"}');
  assert.equal(readFileSync(dir.resolve('image.bin'), 'utf8'), 'REF', 'a binary file is not text to rewrite');
});

test('a file over the ceiling is refused before it fills the disk', () => {
  const dir = createScratchDir({ root: join(tmp(), 'm5') });
  assert.throws(() => dir.writeFile('big', new Uint8Array(MAX_SCRATCH_FILE_BYTES + 1)), /over the/);
});

test('link: a source under a declared credential folder is exposed; anywhere else is refused', () => {
  const home = tmp();
  const creds = join(home, '.acme');
  mkdirSync(creds);
  writeFileSync(join(creds, 'auth.json'), '{"token":"t"}');
  writeFileSync(join(home, 'elsewhere.txt'), 'x');
  const dir = createScratchDir({ root: join(tmp(), 'm6'), linkRoots: [creds] });
  const method = dir.link(join(creds, 'auth.json'), 'auth.json');
  assert.ok(['symlink', 'hardlink', 'copy'].includes(method));
  assert.equal(readFileSync(dir.resolve('auth.json'), 'utf8'), '{"token":"t"}');
  assert.throws(() => dir.link(join(home, 'elsewhere.txt'), 'x'), /not under a credential folder/);
  assert.throws(() => dir.link(join(creds, 'missing.json'), 'x'), /does not exist/);
  // A link that points outside the declared folder is resolved before it is judged.
  if (posix) {
    symlinkSync(join(home, 'elsewhere.txt'), join(creds, 'sneaky'));
    assert.throws(() => dir.link(join(creds, 'sneaky'), 'sneaky'), /not under a credential folder/);
  }
  // No declared folder at all: nothing can be linked.
  const none = createScratchDir({ root: join(tmp(), 'm7') });
  assert.throws(() => none.link(join(creds, 'auth.json'), 'a'), /not under a credential folder/);
});

test('link falls back from a symbolic link to a hard link to a copy, and says which', () => {
  const home = tmp();
  writeFileSync(join(home, 'auth.json'), 'secret');
  const refuse = (what: string) => () => { throw new Error(`${what} refused`); };
  const runOnly = (kind: 'symlink' | 'hardlink' | 'copy') => createScratchDir({
    root: join(tmp(), `chain-${kind}`), linkRoots: [home],
    linkChain: (real, target) => [
      ['symlink', kind === 'symlink' ? () => symlinkSync(real, target) : refuse('symlink')],
      ['hardlink', kind === 'hardlink' ? () => writeFileSync(target, 'hard') : refuse('hardlink')],
      ['copy', kind === 'copy' ? () => writeFileSync(target, 'copied') : refuse('copy')],
    ],
  });
  if (posix) assert.equal(runOnly('symlink').link(join(home, 'auth.json'), 'a'), 'symlink');
  assert.equal(runOnly('hardlink').link(join(home, 'auth.json'), 'a'), 'hardlink');
  assert.equal(runOnly('copy').link(join(home, 'auth.json'), 'a'), 'copy');
  const allRefused = createScratchDir({ root: join(tmp(), 'chain-none'), linkRoots: [home], linkChain: () => [['symlink', refuse('symlink')], ['copy', refuse('copy')]] });
  assert.throws(() => allRefused.link(join(home, 'auth.json'), 'a'), /symlink: symlink refused; copy: copy refused/);
});
