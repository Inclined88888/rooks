/**
 * The thinking of a `claude` spawn: `--effort` for a model with levels, a
 * budget or a switch through the environment for the others, and exactly the
 * former arguments for the shipped profiles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-claude-thinking-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { BUDGET_STEPS, claudeThinking, claudeThinkingControl } = await import('../../official-providers/provider-claude/lib/thinking.js');
const { resolveModelReasoning } = await import('./reasoning.js');
const { reloadLocalBackends, NO_KEY_PLACEHOLDER } = await import('./local-profiles.js');
const { getBackend } = await import('./index.js');
const { mountOfficialProviders, buildUnderSeal } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

type ModelReasoning = import('./reasoning.js').ModelReasoning;
type BuildSpawnOpts = import('./types.js').BuildSpawnOpts;

const BAI = 'https://api.b.ai/v1';
const qwen = resolveModelReasoning({ slug: 'qwen3.8-max', catalog: { baseUrl: BAI } })!;
const opus = resolveModelReasoning({ slug: 'claude-opus-5.5', catalog: { baseUrl: BAI } })!;
const sonnet = resolveModelReasoning({ slug: 'claude-sonnet-4.6', catalog: { baseUrl: BAI } })!;
const toggleOnly: ModelReasoning = { source: 'catalog', thinks: true, controls: [{ type: 'toggle' }] };
const declared: ModelReasoning = { source: 'declared', thinks: true, controls: [{ type: 'levels', values: ['low', 'high'] }] };

const BUDGET_CAPS = { CLAUDE_CODE_MODEL_CAPABILITIES: '-adaptive_thinking,-effort' };
const LEVEL_CAPS = { CLAUDE_CODE_MODEL_CAPABILITIES: 'effort,max_effort,xhigh_effort' };

test('the control driven: budget first from the catalogue, levels from the endpoint', () => {
  assert.equal(claudeThinkingControl(qwen)?.type, 'budget', 'Qwen offers toggle, levels and budget');
  assert.equal(claudeThinkingControl(sonnet)?.type, 'budget');
  assert.equal(claudeThinkingControl(opus)?.type, 'levels');
  assert.equal(claudeThinkingControl(toggleOnly)?.type, 'toggle');
  assert.equal(claudeThinkingControl(declared)?.type, 'levels');
  assert.equal(claudeThinkingControl({ source: 'catalog', thinks: false, controls: [] }), null);
  assert.equal(claudeThinkingControl({ source: 'agent', thinks: true, controls: [] }), null);
  assert.equal(claudeThinkingControl(undefined), null);
});

test('a budget model: no effort, the slider steps or a number become a budget', () => {
  assert.deepEqual(claudeThinking('low', qwen), { args: [], env: { ...BUDGET_CAPS, MAX_THINKING_TOKENS: String(BUDGET_STEPS.low) } });
  assert.deepEqual(claudeThinking('medium', qwen).env.MAX_THINKING_TOKENS, '8000');
  assert.deepEqual(claudeThinking('high', qwen).env.MAX_THINKING_TOKENS, '32000');
  assert.deepEqual(claudeThinking('xhigh', qwen).env.MAX_THINKING_TOKENS, '32000');
  assert.deepEqual(claudeThinking(' 12000 ', qwen).env.MAX_THINKING_TOKENS, '12000');
  assert.deepEqual(claudeThinking('off', qwen), { args: [], env: { ...BUDGET_CAPS, MAX_THINKING_TOKENS: '0' } });
  assert.deepEqual(claudeThinking('banana', qwen), { args: [], env: {} }, 'an unknown value sets nothing');
  assert.deepEqual(claudeThinking(null, qwen), { args: [], env: {} }, 'no value keeps the CLI default');
});

test('a budget stays within the catalogue bounds and the CLI floor', () => {
  const bounded: ModelReasoning = { source: 'catalog', thinks: true, controls: [{ type: 'budget', min: 4096, max: 16000 }] };
  assert.equal(claudeThinking('low', bounded).env.MAX_THINKING_TOKENS, '4096');
  assert.equal(claudeThinking('high', bounded).env.MAX_THINKING_TOKENS, '16000');
  assert.equal(claudeThinking('100', qwen).env.MAX_THINKING_TOKENS, '1024', 'the CLI raises anything below 1024');
  assert.equal(claudeThinking('500000', qwen).env.MAX_THINKING_TOKENS, '262144', 'Qwen max from models.dev');
});

test('a level model: `--effort` as before, every level allowed through', () => {
  assert.deepEqual(claudeThinking('max', opus), { args: ['--effort', 'max'], env: LEVEL_CAPS });
  assert.deepEqual(claudeThinking('high', declared), { args: ['--effort', 'high'], env: LEVEL_CAPS });
  assert.deepEqual(claudeThinking('8000', opus), { args: [], env: {} }, 'a number is no level');
});

test('a switch: on keeps the CLI budget, off sends no thinking', () => {
  assert.deepEqual(claudeThinking('on', toggleOnly), { args: [], env: BUDGET_CAPS });
  assert.deepEqual(claudeThinking('high', toggleOnly), { args: [], env: BUDGET_CAPS });
  assert.deepEqual(claudeThinking('none', toggleOnly), { args: [], env: { ...BUDGET_CAPS, MAX_THINKING_TOKENS: '0' } });
});

test('a budget or a switch declared by hand is driven like the catalogue\'s', () => {
  const budget = { source: 'declared' as const, thinks: true, controls: [{ type: 'budget' as const, max: 4000 }] };
  assert.deepEqual(claudeThinking('8000', budget), { args: [], env: { ...BUDGET_CAPS, MAX_THINKING_TOKENS: '4000' } });
  const toggle = { source: 'declared' as const, thinks: true, controls: [{ type: 'toggle' as const }] };
  assert.deepEqual(claudeThinking('off', toggle), { args: [], env: { ...BUDGET_CAPS, MAX_THINKING_TOKENS: '0' } });
});

test('without a resolution (shipped profiles) only `--effort` is passed, as before', () => {
  assert.deepEqual(claudeThinking('high'), { args: ['--effort', 'high'], env: {} });
  assert.deepEqual(claudeThinking(null), { args: [], env: {} });
  assert.deepEqual(claudeThinking('high', { source: 'catalog', thinks: false, controls: [] }), { args: ['--effort', 'high'], env: {} });
});

test('a model the user or the endpoint says has nothing to set gets nothing, even with an effort stored', () => {
  assert.deepEqual(claudeThinking('high', { source: 'declared', thinks: false, controls: [] }), { args: [], env: {} });
  assert.deepEqual(claudeThinking('high', { source: 'agent', thinks: true, controls: [] }), { args: [], env: {} });
});

function opts(cfg: BuildSpawnOpts['cfg']): BuildSpawnOpts {
  return { agentName: 'acme.main', systemPrompt: 'Test', message: 'Test', resumeSession: null, missionId: randomUUID(), cfg };
}

const THINKING_ENV = ['CLAUDE_CODE_MODEL_CAPABILITIES', 'MAX_THINKING_TOKENS'];

test('spawn: the Claude subscription keeps `--effort` and no thinking variable', async () => {
  const spec = await buildUnderSeal('claude', opts({ model: 'opus', reasoningEffort: 'high' }));
  const at = spec.args.indexOf('--effort');
  assert.ok(at >= 0);
  assert.equal(spec.args[at + 1], 'high');
  for (const name of THINKING_ENV) assert.equal(spec.env?.[name], undefined, name);
});

test('spawn: a custom provider gets the budget of its catalogue model', async () => {
  const dir = join(TMP_HOME, 'backends');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bai.json'), JSON.stringify({
    id: 'bai',
    dialect: 'claude',
    label: 'B.AI',
    env: { ANTHROPIC_BASE_URL: 'https://api.b.ai', ANTHROPIC_AUTH_TOKEN: NO_KEY_PLACEHOLDER },
    defaultModel: 'qwen3.8-max',
    models: [{ slug: 'qwen3.8-max', label: 'Qwen max' }, { slug: 'claude-opus-5.5', label: 'Opus' }],
  }));
  reloadLocalBackends();
  const budget = await buildUnderSeal('bai', opts({ model: 'qwen3.8-max', reasoningEffort: 'medium' }));
  assert.ok(!budget.args.includes('--effort'));
  assert.equal(budget.env?.MAX_THINKING_TOKENS, '8000');
  assert.equal(budget.env?.CLAUDE_CODE_MODEL_CAPABILITIES, '-adaptive_thinking,-effort');
  assert.equal(budget.env?.ANTHROPIC_BASE_URL, 'https://api.b.ai', 'the profile env is kept');
  const levels = await buildUnderSeal('bai', opts({ model: 'claude-opus-5.5', reasoningEffort: 'xhigh' }));
  assert.equal(levels.args[levels.args.indexOf('--effort') + 1], 'xhigh');
  assert.equal(levels.env?.MAX_THINKING_TOKENS, undefined);
});

test('spawn: a custom model declared as not thinking drops the effort the agent still stores', async () => {
  const dir = join(TMP_HOME, 'backends');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bai-none.json'), JSON.stringify({
    id: 'bai-none',
    dialect: 'claude',
    label: 'B.AI',
    env: { ANTHROPIC_BASE_URL: 'https://api.b.ai', ANTHROPIC_AUTH_TOKEN: NO_KEY_PLACEHOLDER },
    defaultModel: 'qwen3.8-max',
    models: [{ slug: 'qwen3.8-max', label: 'Qwen max', reasoningControl: { type: 'none' } }],
  }));
  reloadLocalBackends();
  const spec = await buildUnderSeal('bai-none', opts({ model: 'qwen3.8-max', reasoningEffort: 'high' }));
  assert.ok(!spec.args.includes('--effort'));
  for (const name of THINKING_ENV) assert.equal(spec.env?.[name], undefined, name);
});
