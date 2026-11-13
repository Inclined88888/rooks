/**
 * The Files API answers with forward-slash paths and reads its deny list the
 * way Windows resolves a request — `\` as a separator, any case (TODO #541).
 * The Windows conversion itself is pinned in `host/portable-names.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-files-portable-test-'));
const { AGENTS_DIR } = await import('./paths.js');
const files = await import('./files.js');

const work = mkdtempSync(join(tmpdir(), 'rooks-files-portable-cwd-'));
mkdirSync(join(AGENTS_DIR, 'a'), { recursive: true });
writeFileSync(join(AGENTS_DIR, 'a', 'config.json'), JSON.stringify({ cwd: work }));
mkdirSync(join(work, 'docs', 'sub'), { recursive: true });
mkdirSync(join(work, '.git', 'hooks'), { recursive: true });
mkdirSync(join(work, 'node_modules', 'x'), { recursive: true });
writeFileSync(join(work, 'docs', 'sub', 'a.md'), 'a');
writeFileSync(join(work, 'b.md'), 'b');

test('nested paths come back with forward slashes from every Files call', () => {
  const dir = files.browseAgentFiles('a', 'docs/sub');
  assert.equal(dir.path, 'docs/sub');
  assert.equal(files.browseAgentFiles('a', 'docs/sub/a.md').path, 'docs/sub/a.md');
  assert.equal(files.writeAgentFile('a', 'docs/sub/new.md', 'n').path, 'docs/sub/new.md');
  assert.equal(files.mkdirAgentPath('a', 'docs/sub/deeper').path, 'docs/sub/deeper');
  assert.equal(files.moveAgentPath('a', 'b.md', 'docs/sub').path, 'docs/sub/b.md');
  assert.equal(files.renameAgentPath('a', 'docs/sub/b.md', 'c.md').path, 'docs/sub/c.md');
});

test('a `.git` or `node_modules` path spelled with backslashes or another case is refused, nothing written', () => {
  for (const rel of ['.git\\hooks\\pre-commit', '.GIT/hooks/pre-commit', 'sub\\.git\\config', 'node_modules\\x\\index.js', 'Node_Modules/x/index.js']) {
    assert.throws(() => files.writeAgentFile('a', rel, 'pwned'), /writes refused/, rel);
    assert.throws(() => files.mkdirAgentPath('a', rel), /mkdir refused/, rel);
    assert.throws(() => files.deleteAgentPath('a', rel), /deletes refused/, rel);
  }
  assert.equal(existsSync(join(work, '.git', 'hooks', 'pre-commit')), false);
  // A move's destination is checked in its resolved, forward-slash form: on
  // Windows that form used to keep `\`, and `.git\hooks\a.md` slipped past.
  assert.throws(() => files.moveAgentPath('a', 'docs/sub/a.md', '.git/hooks'), /moves refused/);
  assert.ok(existsSync(join(work, 'docs', 'sub', 'a.md')));
});
