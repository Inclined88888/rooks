/**
 * The Codex account's model cache: read when it is there, ignored when it is
 * not usable, never an error.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { codexAccountLevels, codexAccountSlugs, codexModelsCachePath } = await import('../../official-providers/provider-codex/lib/models-cache.js');

const CODEX_HOME = mkdtempSync(join(tmpdir(), 'timon-codex-cache-'));
process.on('exit', () => rmSync(CODEX_HOME, { recursive: true, force: true }));
const CACHE = join(CODEX_HOME, 'models_cache.json');

function levels(...efforts: string[]) {
  return efforts.map((effort) => ({ effort, description: `${effort} reasoning` }));
}

test('without CODEX_HOME, the test runner reads no account', () => {
  const saved = process.env['CODEX_HOME'];
  delete process.env['CODEX_HOME'];
  try {
    assert.equal(codexModelsCachePath(), null);
    assert.equal(codexAccountLevels(), null);
  } finally {
    if (saved !== undefined) process.env['CODEX_HOME'] = saved;
  }
});

test('a present cache gives the levels of each model it lists, unknown keys tolerated', () => {
  process.env['CODEX_HOME'] = CODEX_HOME;
  writeFileSync(CACHE, JSON.stringify({
    fetched_at: '2026-10-05T00:00:00Z', client_version: '0.160.0',
    models: [
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', default_reasoning_level: 'low', visibility: 'list',
        supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
      { slug: 'codex-auto-review', visibility: 'hide' },
    ],
  }));
  const found = codexAccountLevels();
  assert.deepEqual(found?.get('gpt-6.1-sol'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(found?.has('codex-auto-review'), false, 'a model without levels keeps what the profile says');
});

test('a rewritten cache is read again', () => {
  process.env['CODEX_HOME'] = CODEX_HOME;
  writeFileSync(CACHE, JSON.stringify({ models: [{ slug: 'gpt-5.5', supported_reasoning_levels: levels('low') }] }));
  assert.deepEqual(codexAccountLevels()?.get('gpt-5.5'), ['low']);
  writeFileSync(CACHE, JSON.stringify({ models: [{ slug: 'gpt-5.5', supported_reasoning_levels: levels('low', 'high') }] }));
  assert.deepEqual(codexAccountLevels()?.get('gpt-5.5'), ['low', 'high']);
});

test('an absent, corrupt or invalid cache is no cache', () => {
  process.env['CODEX_HOME'] = CODEX_HOME;
  rmSync(CACHE, { force: true });
  assert.equal(codexAccountLevels(), null, 'absent');
  writeFileSync(CACHE, '{"models": [');
  assert.equal(codexAccountLevels(), null, 'not JSON');
  writeFileSync(CACHE, JSON.stringify({ models: 'gpt-5.5' }));
  assert.equal(codexAccountLevels(), null, 'wrong shape');
  writeFileSync(CACHE, JSON.stringify({ models: [{ slug: 'gpt-5.5', supported_reasoning_levels: levels('low; rm -rf') }] }));
  assert.equal(codexAccountLevels(), null, 'a level that is not a plain name never reaches a CLI argument');
});

// ── codexAccountSlugs ────────────────────────────────────────────────────────

test('codexAccountSlugs: without CODEX_HOME the test runner returns null', () => {
  const saved = process.env['CODEX_HOME'];
  delete process.env['CODEX_HOME'];
  try {
    assert.equal(codexAccountSlugs(), null);
  } finally {
    if (saved !== undefined) process.env['CODEX_HOME'] = saved;
  }
});

test('codexAccountSlugs: only models with visibility list are returned', () => {
  process.env['CODEX_HOME'] = CODEX_HOME;
  writeFileSync(CACHE, JSON.stringify({
    models: [
      { slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: levels('low', 'medium') },
      { slug: 'gpt-6-luna', visibility: 'list' },
      { slug: 'codex-auto-review', visibility: 'hide' },
      { slug: 'gpt-internal', visibility: 'internal' },
      { slug: 'gpt-no-visibility' },
    ],
  }));
  assert.deepEqual(codexAccountSlugs(), ['gpt-6.1-sol', 'gpt-6-luna']);
});

test('codexAccountSlugs: cache and levels share one read (mtime cached)', () => {
  process.env['CODEX_HOME'] = CODEX_HOME;
  writeFileSync(CACHE, JSON.stringify({
    models: [
      { slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: levels('low', 'high') },
    ],
  }));
  assert.deepEqual(codexAccountSlugs(), ['gpt-6.1-sol']);
  assert.deepEqual(codexAccountLevels()?.get('gpt-6.1-sol'), ['low', 'high'], 'levels readable from same cache read');
});

test('codexAccountSlugs: absent, corrupt or invalid cache returns null', () => {
  process.env['CODEX_HOME'] = CODEX_HOME;
  rmSync(CACHE, { force: true });
  assert.equal(codexAccountSlugs(), null, 'absent');
  writeFileSync(CACHE, '{"models": [');
  assert.equal(codexAccountSlugs(), null, 'not JSON');
  writeFileSync(CACHE, JSON.stringify({ models: 'bad' }));
  assert.equal(codexAccountSlugs(), null, 'wrong shape');
});

test('the ceilings and names the core\'s schema held are still held: 500 models, 12 levels, a slug of 1 to 200 characters, a visibility that is a string', () => {
  process.env['CODEX_HOME'] = CODEX_HOME;
  const model = (extra: object = {}) => ({ slug: 'gpt-5.5', visibility: 'list', ...extra });
  writeFileSync(CACHE, JSON.stringify({ models: Array.from({ length: 500 }, (_, i) => model({ slug: `m${i}` })) }));
  assert.equal(codexAccountSlugs()?.length, 500, '500 is allowed');
  writeFileSync(CACHE, JSON.stringify({ models: Array.from({ length: 501 }, (_, i) => model({ slug: `m${i}` })) }));
  assert.equal(codexAccountSlugs(), null, '501 is not');
  const twelve = Array.from({ length: 12 }, (_, i) => ({ effort: `l${i}` }));
  writeFileSync(CACHE, JSON.stringify({ models: [model({ supported_reasoning_levels: twelve })] }));
  assert.equal(codexAccountLevels()?.get('gpt-5.5')?.length, 12);
  writeFileSync(CACHE, JSON.stringify({ models: [model({ supported_reasoning_levels: [...twelve, { effort: 'l12' }] })] }));
  assert.equal(codexAccountLevels(), null, 'thirteen levels');
  for (const bad of [{ slug: '' }, { slug: 'x'.repeat(201) }, { slug: 5 }, { visibility: 3 }, { supported_reasoning_levels: [{ effort: 'Low' }] }, { supported_reasoning_levels: [{}] }, { supported_reasoning_levels: 'low' }]) {
    writeFileSync(CACHE, JSON.stringify({ models: [model(), model({ slug: 'other', ...bad })] }));
    assert.equal(codexAccountSlugs(), null, JSON.stringify(bad));
  }
  writeFileSync(CACHE, JSON.stringify({ models: [model({ slug: 'a'.repeat(200) })], an_unknown_key: { nested: true } }));
  assert.equal(codexAccountSlugs()?.length, 1, 'unknown keys are tolerated');
  writeFileSync(CACHE, JSON.stringify([]));
  assert.equal(codexAccountSlugs(), null, 'not an object');
});
