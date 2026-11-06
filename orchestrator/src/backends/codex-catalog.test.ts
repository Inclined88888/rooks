/**
 * Codex catalogue: slugs from the account's models_cache.json (visibility:
 * list) are merged into the catalogue; the frozen profile list is the fallback
 * when the cache is absent, unreadable or empty.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-codex-catalog-'));
process.env.TIMON_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const CODEX_HOME = mkdtempSync(join(tmpdir(), 'timon-codex-catalog-codex-'));
const CACHE = join(CODEX_HOME, 'models_cache.json');
process.on('exit', () => rmSync(CODEX_HOME, { recursive: true, force: true }));

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { catalogBackend } = await import('./catalog.js');

function writeCache(models: object[]): void {
  writeFileSync(CACHE, JSON.stringify({ models }));
}

test('a slug in the cache with visibility:list that the profile does not know appears in the catalogue', () => {
  process.env.CODEX_HOME = CODEX_HOME;
  writeCache([
    { slug: 'gpt-6.1-sol', visibility: 'list' },
    { slug: 'gpt-6-luna', visibility: 'list' },
  ]);
  const backend = catalogBackend('codex');
  assert.ok(backend, 'codex backend is active');
  const slugs = backend!.models.map((m) => m.slug);
  assert.ok(slugs.includes('gpt-6.1-sol'), 'cache-only slug gpt-6.1-sol present');
  assert.ok(slugs.includes('gpt-6-luna'), 'cache-only slug gpt-6-luna present');
});

test('a slug already in the profile is not duplicated', () => {
  process.env.CODEX_HOME = CODEX_HOME;
  writeCache([
    { slug: 'gpt-5.6-sol', visibility: 'list' },
    { slug: 'gpt-6.1-sol', visibility: 'list' },
  ]);
  const backend = catalogBackend('codex');
  assert.ok(backend, 'codex backend is active');
  const profileSlug = backend!.models.filter((m) => m.slug === 'gpt-5.6-sol');
  assert.equal(profileSlug.length, 1, 'gpt-5.6-sol appears exactly once');
});

test('a slug with visibility other than list is not injected', () => {
  process.env.CODEX_HOME = CODEX_HOME;
  writeCache([
    { slug: 'codex-auto-review', visibility: 'hide' },
    { slug: 'internal-model', visibility: 'internal' },
    { slug: 'no-visibility-model' },
  ]);
  const backend = catalogBackend('codex');
  assert.ok(backend, 'codex backend is active');
  const slugs = backend!.models.map((m) => m.slug);
  assert.ok(!slugs.includes('codex-auto-review'), 'hide is excluded');
  assert.ok(!slugs.includes('internal-model'), 'internal is excluded');
  assert.ok(!slugs.includes('no-visibility-model'), 'no visibility is excluded');
});

test('when CODEX_HOME is unset the frozen profile list is the fallback', () => {
  delete process.env.CODEX_HOME;
  const backend = catalogBackend('codex');
  assert.ok(backend, 'codex backend is active');
  // The frozen list always has gpt-5.6-sol; gpt-6.1-sol is cache-only.
  const slugs = backend!.models.map((m) => m.slug);
  assert.ok(slugs.includes('gpt-5.6-sol'), 'frozen model gpt-5.6-sol present');
  assert.ok(!slugs.includes('gpt-6.1-sol'), 'cache-only gpt-6.1-sol absent when cache unset');
});

test('a cache-only slug carries reasoning levels from the account cache', () => {
  process.env.CODEX_HOME = CODEX_HOME;
  writeCache([
    { slug: 'gpt-6.1-sol', visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }] },
  ]);
  const backend = catalogBackend('codex');
  assert.ok(backend, 'codex backend is active');
  const model = backend!.models.find((m) => m.slug === 'gpt-6.1-sol');
  assert.ok(model, 'cache-only model in catalogue');
  assert.deepEqual(model!.supportedReasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});
