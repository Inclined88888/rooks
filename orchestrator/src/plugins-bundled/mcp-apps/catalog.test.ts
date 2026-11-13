/**
 * The reviewed entries ship as they were reviewed: every file of `catalog/`
 * is loaded (a file left out of `catalog.ts` is a publisher that silently
 * disappears), each one validates, and none carries anything that looks like
 * a credential (docs/MCP-APPS.md §3: no secret in the data).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { APP_CATALOG, appServerId } from './catalog.js';
import { APP_CATEGORIES, appEntrySchema } from './schema.js';

const DIR = fileURLToPath(new URL('./catalog/', import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

test('every file of catalog/ is loaded, under its own slug', () => {
  assert.deepEqual(APP_CATALOG.map((e) => `${e.slug}.json`).sort(), files);
  assert.ok(APP_CATALOG.length >= 15, 'the first catalogue holds about fifteen publishers');
});

test('each entry validates on its own and each category is used', () => {
  for (const file of files) {
    const parsed = appEntrySchema.safeParse(JSON.parse(readFileSync(join(DIR, file), 'utf8')));
    assert.ok(parsed.success, `${file}: ${parsed.success ? '' : parsed.error.message}`);
  }
  for (const category of APP_CATEGORIES) {
    assert.ok(APP_CATALOG.some((e) => e.category === category), `category ${category} is empty`);
  }
});

test('an unknown key is refused: a typo must not drop a field silently', () => {
  const sample = JSON.parse(readFileSync(join(DIR, files[0]!), 'utf8')) as Record<string, unknown>;
  assert.equal(appEntrySchema.safeParse({ ...sample, privacey: 'https://example.com' }).success, false);
  assert.equal(appEntrySchema.safeParse({ ...sample, mcp: { url: 'http://insecure.example/mcp', transport: 'streamable-http' } }).success, false);
});

test('every entry ships its publisher\'s logo, as path data only', () => {
  for (const entry of APP_CATALOG) assert.ok(entry.icon.logo, `${entry.slug}: no logo`);
  const sample = JSON.parse(readFileSync(join(DIR, files[0]!), 'utf8')) as { icon: { logo: { paths: { d: string }[] } } };
  const withPath = (d: string) => ({ ...sample, icon: { ...sample.icon, logo: { ...sample.icon.logo, paths: [{ d }] } } });
  assert.equal(appEntrySchema.safeParse(withPath('M0 0L24 24Z')).success, true);
  // Markup or a reference smuggled into `d` never reaches a card.
  assert.equal(appEntrySchema.safeParse(withPath('M0 0"/><script>alert(1)</script>')).success, false);
  assert.equal(appEntrySchema.safeParse(withPath('url(https://example.com/x)')).success, false);
});

test('no entry carries a credential', () => {
  const credential = /(ghp_|github_pat_|glpat-|sk_live_|sk_test_|rk_live_|xox[abp]-|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.|Bearer\s+[A-Za-z0-9._-]{12,})/;
  for (const file of files) {
    const raw = readFileSync(join(DIR, file), 'utf8');
    assert.doesNotMatch(raw, credential, `${file} looks like it holds a secret`);
    for (const entry of APP_CATALOG) {
      const query = new URL(entry.mcp.url).searchParams;
      assert.ok(![...query.keys()].some((k) => /key|token|secret/i.test(k)), `${entry.slug}: a secret in the endpoint's query`);
    }
  }
});

test('a server id stays a valid MCP id', () => {
  for (const entry of APP_CATALOG) assert.match(appServerId(entry.slug), /^[a-z0-9._-]+$/);
});
