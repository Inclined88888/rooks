import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaseNotes, readReleaseNotes, selectReleaseNotes } from '../../desktop/scripts/release-notes.mjs';
const changelog = '# Internal preamble\n## [Unreleased]\n- Preview\n## [1.2.0] — 2026-09-20\n- Second\n## [1.0.0] — 2026-09-01\n- First\n';
test('extracts version interval with missing boundaries and ignores Unreleased', () => {
  const notes = createReleaseNotes(changelog, '1.3.0');
  for (const from of ['1.0.0', '1.1.0']) assert.deepEqual(selectReleaseNotes(notes, from).map(e => e.version), ['1.2.0']);
  for (const from of ['1.3.0', '2.0.0', 'unknown']) assert.deepEqual(selectReleaseNotes(notes, from), []);
  assert.equal(notes.entries[0]?.date, '2026-09-20');
  assert.doesNotMatch(JSON.stringify(notes), /Preview|Internal preamble|Unreleased/);
});
test('RC snapshot uses latest stable below target and numeric RC ordering', () => {
  const notes = createReleaseNotes(changelog, '1.1.0-rc.2');
  assert.deepEqual(notes.entries[0], { version: '1.1.0-rc.2', baseVersion: '1.0.0', date: null, content: '- Preview', prerelease: true });
  assert.deepEqual(selectReleaseNotes(notes, '1.1.0-rc.1').map(e => e.version), ['1.1.0-rc.2']);
  assert.deepEqual(selectReleaseNotes(notes, '1.1.0-rc.10'), []);
  assert.deepEqual(selectReleaseNotes(createReleaseNotes(changelog, '1.2.0'), '1.2.0-rc.2').map(e => e.version), ['1.2.0']);
});
test('empty/malformed changelogs never fail and malformed headings terminate sections', () => {
  for (const input of ['', '# text', '## [banana]\nwrong']) assert.deepEqual(createReleaseNotes(input, '1.0.0').entries, []);
  assert.equal(createReleaseNotes('## [1.0.0]\nGood\n## malformed\nBad', '1.0.0').entries[0]?.content, 'Good');
  assert.equal(createReleaseNotes('', '1.1.0-rc.1').entries[0]?.content, '');
  assert.equal(createReleaseNotes(changelog.replaceAll('\n', '\r\n'), '1.3.0').entries.length, 2);
});
test('reader safely handles absent, corrupted and invalid files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-notes-'));
  const path = join(dir, 'notes.json');
  try {
    assert.equal(readReleaseNotes(path), null);
    for (const value of ['{', '{}', JSON.stringify({ schemaVersion: 1, packageVersion: '1.0.0', entries: [null] })]) {
      writeFileSync(path, value); assert.equal(readReleaseNotes(path), null);
    }
    const notes = createReleaseNotes(changelog, '1.2.0');
    writeFileSync(path, JSON.stringify(notes)); assert.deepEqual(readReleaseNotes(path), notes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('public page only includes published sections and checks publication policy', async () => {
  // @ts-expect-error Build-time generator has no runtime TypeScript consumer.
  const { renderChangelog } = await import('../../public-docs/scripts/gen-changelog.mjs');
  assert.match(renderChangelog(changelog), /slug: \/changelog/);
  assert.doesNotMatch(renderChangelog(changelog), /- Preview|Internal preamble|Unreleased/);
  assert.throws(() => renderChangelog('## [1.0.0]\nADMIN_KEY'));
  const config = readFileSync(new URL('../../desktop/electron-builder.yml', import.meta.url), 'utf8');
  assert.match(config, /from: build-resources\/daemon-release\/scripts\s+to: orchestrator\/scripts/);
  assert.match(config, /- scripts\/release-notes.mjs/);
});
test('release inventory signs the offline JSON and detects altered notes', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { mkdirSync } = await import('node:fs');
  // @ts-expect-error Packaging helper is JavaScript and used here without compiling a daemon.
  const { RELEASE_MANIFEST_VERSION, productFiles, digest, verifyRelease } = await import('../../desktop/scripts/release-integrity.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'timon-notes-signed-'));
  try {
    for (const name of ['dist', 'bin', 'scripts', 'presets']) mkdirSync(join(dir, name));
    writeFileSync(join(dir, 'package.json'), '{}');
    const path = join(dir, 'scripts', 'release-notes.json');
    writeFileSync(path, JSON.stringify(createReleaseNotes(changelog, '1.2.0')));
    const files = Object.fromEntries(productFiles(dir).map((name: string) => [name, digest(join(dir, name))]));
    const body = JSON.stringify({ version: RELEASE_MANIFEST_VERSION, files });
    const keys = generateKeyPairSync('ed25519');
    writeFileSync(join(dir, 'release-manifest.json'), body);
    writeFileSync(join(dir, 'release-manifest.sig'), sign(null, Buffer.from(body), keys.privateKey));
    assert.doesNotThrow(() => verifyRelease(dir, keys.publicKey));
    writeFileSync(path, '{}');
    assert.throws(() => verifyRelease(dir, keys.publicKey), /integrity failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// Update 0.1.1-rc.7 → 0.1.2-rc.1: the 0.1.1 known issue sat under the fix that closed it.
test('only the newest release shown keeps its known issues', () => {
  const md = '## [Unreleased]\n### Fixed\n- Vault key works\n### Known issues\n- Still open\n'
    + '## [1.1.0] — 2026-09-21\n### Fixed\n- Old fix\n### Known issues\n- Vault key ignored\n### Changed\n- Kept\n';
  const shown = selectReleaseNotes(createReleaseNotes(md, '1.2.0-rc.1'), '1.1.0-rc.7');
  assert.deepEqual(shown.map(e => e.version), ['1.2.0-rc.1', '1.1.0']);
  assert.match(shown[0]!.content, /Still open/);
  assert.doesNotMatch(shown[1]!.content, /Known issues|Vault key ignored/);
  assert.match(shown[1]!.content, /Old fix[\s\S]*### Changed\n- Kept/);
});
