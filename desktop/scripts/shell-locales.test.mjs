import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPackagedShellLocales, copyShellLocales, shellLocaleFiles, SHELL_LOCALES_SOURCE } from './shell-locales.mjs';

function sources() {
  const dir = mkdtempSync(join(tmpdir(), 'shell-locales-'));
  for (const [path, text] of Object.entries({
    'en/meta.json': '{"name":"English"}', 'en/desktop.json': '{"desktop":{}}', 'en/core.json': '{}',
    'de/meta.json': '{"name":"Deutsch"}', 'de/core.json': '{}',
    'notes/desktop.json': '{}', '.generated/en.ts': '',
  })) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test('only meta.json and desktop.json of a language travel; web messages and tool folders stay', () => {
  assert.deepEqual(shellLocaleFiles(sources()), [join('de', 'meta.json'), join('en', 'desktop.json'), join('en', 'meta.json')]);
});

test('the checkout ships English and French shell messages', () => {
  const files = shellLocaleFiles(SHELL_LOCALES_SOURCE);
  for (const tag of ['en', 'fr']) assert.ok(files.includes(join(tag, 'desktop.json')), tag);
});

test('a checkout without en/desktop.json refuses to pack', () => {
  const dir = sources();
  rmSync(join(dir, 'en', 'desktop.json'));
  assert.throws(() => shellLocaleFiles(dir), /en\/desktop\.json|en\\desktop\.json/);
});

test('the copy replaces the target, and afterPack refuses a missing or stale file', () => {
  const dir = sources();
  const resources = mkdtempSync(join(tmpdir(), 'resources-'));
  writeFileSync(join(resources, 'stale'), '');
  mkdirSync(join(resources, 'locales', 'xx'), { recursive: true });
  copyShellLocales(dir, join(resources, 'locales'));
  assert.equal(readFileSync(join(resources, 'locales', 'en', 'desktop.json'), 'utf8'), '{"desktop":{}}');
  assert.doesNotThrow(() => assertPackagedShellLocales(resources, dir));
  writeFileSync(join(resources, 'locales', 'en', 'desktop.json'), '{}');
  assert.throws(() => assertPackagedShellLocales(resources, dir), /not the one of this checkout/);
  rmSync(join(resources, 'locales', 'de'), { recursive: true });
  assert.throws(() => assertPackagedShellLocales(resources, dir), /is missing/);
});
