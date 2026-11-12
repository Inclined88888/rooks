/**
 * Custom directives leave `config.json` for `directives.md`: never lost, never
 * overwriting a doc the user already has, and a no-op once done.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { agentDir } = await import('./paths.js');
await import('../tests/helpers/claude-provider.js');

const { loadConfig, upsertAgent } = await import('./agent.js');
const { migrateDirectivesToDocs } = await import('./agent-directives-migration.js');

test('the directives move to directives.md and leave the config', () => {
  upsertAgent({ name: 'dm-a', system_prompt: '# a\n', config: { directives: 'be brief' } });
  upsertAgent({ name: 'dm-none', system_prompt: '# n\n', config: {} });

  assert.ok(migrateDirectivesToDocs() >= 1);
  assert.equal(readFileSync(join(agentDir('dm-a'), 'directives.md'), 'utf8'), '# Directives\n\nbe brief\n');
  assert.equal(loadConfig('dm-a').directives, undefined);
  assert.ok(!existsSync(join(agentDir('dm-none'), 'directives.md')), 'an agent without directives gets no doc');
  assert.equal(migrateDirectivesToDocs(), 0, 'nothing left to move');
});

test('an existing directives.md is appended to, never overwritten', () => {
  upsertAgent({ name: 'dm-b', system_prompt: '# b\n', config: { directives: 'second' } });
  writeFileSync(join(agentDir('dm-b'), 'directives.md'), '# Mine\n\nfirst\n');
  migrateDirectivesToDocs();
  assert.equal(readFileSync(join(agentDir('dm-b'), 'directives.md'), 'utf8'), '# Mine\n\nfirst\n\nsecond\n');
});

test('an editor save that does not mention the directives keeps them', () => {
  upsertAgent({ name: 'dm-c', system_prompt: '# c\n', config: { directives: 'keep me' } });
  upsertAgent({ name: 'dm-c', system_prompt: '# c\n', config: { role: 'coder' } });
  assert.equal(loadConfig('dm-c').directives, 'keep me');
  upsertAgent({ name: 'dm-c', system_prompt: '# c\n', config: { directives: '' } });
  assert.equal(loadConfig('dm-c').directives, '', 'an explicit value still wins');
});
