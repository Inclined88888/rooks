import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProviderContext, defineConformanceTests, dialectConformance } from '../../../packages/sdk/src/testing/index.js';
import { createClaudeProvider } from '../../official-providers/provider-claude/lib/claude.js';
import { createClaudeToken } from '../../official-providers/provider-claude/lib/token.js';
import { createClaudeUsage } from '../../official-providers/provider-claude/lib/usage.js';
import { apply } from '../../official-providers/provider-kimi/lib/index.js';
const ctx = createProviderContext();
const token = createClaudeToken(ctx.provider);
ctx.provider.registerProvider(createClaudeProvider(ctx.provider, token, createClaudeUsage(ctx.provider, token)));
apply(ctx);
const env = { ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic', ANTHROPIC_AUTH_TOKEN: 'test-key' };
const dialect = ctx.registered.dialect('claude');
const scratch = await ctx.provider.scratch.mission({ missionId: 'mission-contract-0001' } as never);
process.on('exit', () => ctx.cleanup());
defineConformanceTests(test, dialectConformance(dialect, { id: 'kimi', cmd: 'claude', env }, {
 transcript: readFileSync(join(import.meta.dirname, '../backends/__fixtures__/claude.jsonl'), 'utf8'),
 sessionId: '3f9a1c52-7e64-4d0b-9a11-0b2c8de41f77', cmd: 'claude', model: 'kimi-k3',
}, { cwd: scratch.path, scratchDirs: [scratch.path] }), '[Kimi plugin]');
test('Kimi preserves its profile id, fallback rank, key reference and credential directory', () => {
  const profile = ctx.registered.productProfiles.find((p) => p.id === 'kimi')!;
  assert.equal(profile.dialect, 'claude');
  assert.equal(profile.fallbackRank, 40);
  assert.deepEqual(profile.credentialDirs, ['.kimi']);
  assert.deepEqual(profile.env.ANTHROPIC_AUTH_TOKEN, { secret: 'KIMI_API_KEY' });
});
