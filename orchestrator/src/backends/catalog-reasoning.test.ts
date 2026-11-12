/**
 * The thinking controls the catalogue serves per model: where they come from
 * (declared, agent, models.dev) and what they never touch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-catalog-reasoning-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { reloadLocalBackends, NO_KEY_PLACEHOLDER } = await import('./local-profiles.js');
const { activeProfiles } = await import('./registry.js');
const { catalogBackend } = await import('./catalog.js');
const { refreshModels } = await import('./model-discovery.js');

const DIR = join(TMP_HOME, 'backends');
mkdirSync(DIR, { recursive: true });

function dropBai(): void {
  writeFileSync(join(DIR, 'bai.json'), JSON.stringify({
    id: 'bai',
    dialect: 'claude',
    label: 'B.AI',
    env: { ANTHROPIC_BASE_URL: 'https://api.b.ai', ANTHROPIC_AUTH_TOKEN: NO_KEY_PLACEHOLDER },
    defaultModel: 'qwen3.8-max',
    models: [
      { slug: 'qwen3.8-max', label: 'Qwen max' },
      { slug: 'claude-sonnet-4.6', label: 'Sonnet', supportedReasoningLevels: ['low', 'high'] },
      { slug: 'house-model', label: 'House' },
    ],
  }));
  reloadLocalBackends();
}

{
  const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('a custom provider gets the catalogue controls, without a slider', () => {
  dropBai();
  const models = catalogBackend('bai')!.models;
  const qwen = models.find((m) => m.slug === 'qwen3.8-max')!;
  assert.equal(qwen.reasoning?.source, 'catalog');
  assert.equal(qwen.reasoning?.catalogEntry, 'alibaba/qwen3.8-max');
  assert.deepEqual(qwen.reasoning?.controls.map((c) => c.type), ['toggle', 'levels', 'budget']);
  assert.equal(qwen.supportedReasoningLevels, undefined, 'the catalogue never feeds the slider field');
  assert.equal(models.find((m) => m.slug === 'house-model')!.reasoning, undefined);
});

test('declared levels are kept and win over the catalogue', () => {
  dropBai();
  const sonnet = catalogBackend('bai')!.models.find((m) => m.slug === 'claude-sonnet-4.6')!;
  assert.deepEqual(sonnet.supportedReasoningLevels, ['low', 'high']);
  assert.deepEqual(sonnet.reasoning, { source: 'declared', thinks: true, controls: [{ type: 'levels', values: ['low', 'high'] }] });
});

test('levels that only the agent reported are marked as such', async () => {
  dropBai();
  const profile = activeProfiles().find(({ profile: p }) => p.id === 'bai')!.profile;
  await refreshModels(profile, true, async () => [
    { slug: 'qwen3.8-max', supportedReasoningLevels: ['on'] },
    { slug: 'claude-sonnet-4.6', supportedReasoningLevels: ['max'] },
    { slug: 'agent-only', supportedReasoningLevels: ['low', 'high'] },
  ]);
  const models = catalogBackend('bai')!.models;
  assert.deepEqual(models.find((m) => m.slug === 'qwen3.8-max')!.reasoning, { source: 'agent', thinks: true, controls: [{ type: 'levels', values: ['on'] }] });
  assert.equal(models.find((m) => m.slug === 'agent-only')!.reasoning?.source, 'agent');
  assert.equal(models.find((m) => m.slug === 'claude-sonnet-4.6')!.reasoning?.source, 'declared', 'the profile still wins');
});

test('an endpoint that reported no level is not overridden by the catalogue', () => {
  writeFileSync(join(DIR, 'reported-none.json'), JSON.stringify({
    id: 'reported-none',
    dialect: 'claude',
    label: 'Reported none',
    env: { ANTHROPIC_BASE_URL: 'https://api.b.ai', ANTHROPIC_AUTH_TOKEN: NO_KEY_PLACEHOLDER },
    defaultModel: 'claude-opus-5.5',
    models: [
      { slug: 'claude-opus-5.5', label: 'Opus', reportedReasoningLevels: [] },
      { slug: 'claude-sonnet-4.6', label: 'Sonnet', supportedReasoningLevels: [], reportedReasoningLevels: ['max'] },
      { slug: 'qwen3.8-max', label: 'Qwen', supportedReasoningLevels: [] },
    ],
  }));
  const loaded = reloadLocalBackends().find((entry) => entry.id === 'reported-none');
  assert.equal(loaded?.issue, null, loaded?.issue ?? undefined);
  const models = catalogBackend('reported-none')!.models;
  const of = (slug: string) => models.find((m) => m.slug === slug)!;
  assert.deepEqual(of('claude-opus-5.5').reasoning, { source: 'agent', thinks: true, controls: [] });
  assert.equal(of('claude-opus-5.5').supportedReasoningLevels, undefined);
  assert.deepEqual(of('claude-sonnet-4.6').reasoning, { source: 'agent', thinks: true, controls: [{ type: 'levels', values: ['max'] }] },
    'an emptied declaration is no declaration, and not the agent\'s either');
  assert.equal(of('qwen3.8-max').reasoning?.source, 'catalog');
});

test('a first-party backend never consults the catalogue', () => {
  const claude = catalogBackend('claude');
  if (!claude) return; // not installed on this machine: nothing to check
  for (const model of claude.models) assert.notEqual(model.reasoning?.source, 'catalog', model.slug);
});

function writeCodexCache(body: string): string {
  const home = mkdtempSync(join(tmpdir(), 'rooks-codex-home-'));
  writeFileSync(join(home, 'models_cache.json'), body);
  process.env['CODEX_HOME'] = home;
  return home;
}

const ACCOUNT_CACHE = JSON.stringify({
  models: [
    { slug: 'gpt-5.5', default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort })) },
    { slug: 'gpt-5.6-sol', supported_reasoning_levels: [] },
  ],
});

test('the Codex account cache replaces the frozen levels, slider and resolution alike', () => {
  const home = writeCodexCache(ACCOUNT_CACHE);
  try {
    const models = catalogBackend('codex')!.models;
    const gpt55 = models.find((m) => m.slug === 'gpt-5.5')!;
    assert.deepEqual(gpt55.supportedReasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(gpt55.reasoning, { source: 'agent', thinks: true, controls: [{ type: 'levels', values: ['low', 'medium', 'high', 'xhigh', 'max'] }] });
    const sol = models.find((m) => m.slug === 'gpt-5.6-sol')!;
    assert.deepEqual(sol.supportedReasoningLevels, ['low', 'medium', 'high', 'xhigh'], 'listed without levels: the frozen list stays');
    assert.equal(sol.reasoning?.source, 'declared');
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env['CODEX_HOME'];
  }
});

test('an absent or corrupt Codex cache falls back to the frozen levels', () => {
  for (const body of [null, '{"models": [', JSON.stringify({ models: [{ slug: 'gpt-5.5', supported_reasoning_levels: 'max' }] })]) {
    const home = writeCodexCache(body ?? '');
    if (body === null) rmSync(join(home, 'models_cache.json'));
    try {
      const gpt55 = catalogBackend('codex')!.models.find((m) => m.slug === 'gpt-5.5')!;
      assert.deepEqual(gpt55.supportedReasoningLevels, ['low', 'medium', 'high', 'xhigh'], String(body));
      assert.equal(gpt55.reasoning?.source, 'declared');
    } finally {
      rmSync(home, { recursive: true, force: true });
      delete process.env['CODEX_HOME'];
    }
  }
});

test('a custom openai-responses provider never takes the Codex account levels', () => {
  writeFileSync(join(DIR, 'resp.json'), JSON.stringify({
    id: 'resp',
    dialect: 'codex',
    label: 'Responses gateway',
    env: { BACKEND_RESP_KEY: NO_KEY_PLACEHOLDER },
    providerConfig: { id: 'rooks-resp', name: 'Responses gateway', baseUrl: 'https://gateway.example/v1', envKey: 'BACKEND_RESP_KEY', wireApi: 'responses' },
    defaultModel: 'gpt-5.5',
    models: [{ slug: 'gpt-5.5', label: 'gpt-5.5' }],
  }));
  const loaded = reloadLocalBackends().find((entry) => entry.id === 'resp');
  assert.equal(loaded?.issue, null, loaded?.issue ?? undefined);
  const home = writeCodexCache(ACCOUNT_CACHE);
  try {
    const gpt55 = catalogBackend('resp')!.models.find((m) => m.slug === 'gpt-5.5')!;
    assert.equal(gpt55.supportedReasoningLevels, undefined);
    assert.equal(gpt55.reasoning?.source, 'catalog', 'the catalogue answers, not the account');
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env['CODEX_HOME'];
  }
});
