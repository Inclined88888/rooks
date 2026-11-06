/** The Files listing carries absolute host paths, built by the daemon, for the "Copy path" menu entry (TODO #422). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-files-abs-test-'));
const { AGENTS_DIR } = await import('./paths.js');
const { browseAgentFiles } = await import('./files.js');

const work = realpathSync(mkdtempSync(join(tmpdir(), 'timon-files-abs-cwd-')));
mkdirSync(join(AGENTS_DIR, 'a'), { recursive: true });
writeFileSync(join(AGENTS_DIR, 'a', 'config.json'), JSON.stringify({ cwd: work }));
mkdirSync(join(work, 'src'));
writeFileSync(join(work, 'src', 'x.ts'), 'x');

test('the root listing and its entries carry the absolute path', () => {
  const r = browseAgentFiles('a', '');
  assert.equal(r.kind, 'dir');
  if (r.kind !== 'dir') return;
  assert.equal(r.abs, work);
  assert.equal(r.entries.find((e) => e.name === 'src')?.abs, join(work, 'src'));
});

test('a nested listing carries the absolute path of its files', () => {
  const r = browseAgentFiles('a', 'src');
  if (r.kind !== 'dir') throw new Error('expected a dir');
  assert.equal(r.abs, join(work, 'src'));
  assert.equal(r.entries[0].abs, join(work, 'src', 'x.ts'));
});
