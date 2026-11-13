/**
 * `SOUL.md` — the identity the USER gives an agent.
 *
 * Two invariants, and the second is the reason the file exists at all:
 *   1. its content reaches the effective prompt;
 *   2. `system-prompt.md` is untouched. Onboarding lets someone name their
 *      orchestrator and describe it in their own words; if that had been
 *      written into the seeded prompt, the technical instructions the
 *      orchestrator needs would have been overwritten by a personality.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { agentDir } = await import('./paths.js');
await import('../tests/helpers/claude-provider.js');

const { buildEffectivePrompt, loadConfig, loadSoul, upsertAgent } = await import('./agent.js');
const { getBackend } = await import('./backends/index.js');

test('SOUL.md is injected before the role and leaves the system prompt alone', () => {
  const agent = 'soul-test';
  upsertAgent({ name: agent, system_prompt: 'TECHNICAL INSTRUCTIONS', config: { role: 'orchestrator' } });
  const backend = getBackend('claude');

  const before = buildEffectivePrompt(agent, loadConfig(agent), backend);
  assert.doesNotMatch(before, /# Who you are/, 'no soul, no block');

  writeFileSync(join(agentDir(agent), 'SOUL.md'), 'My name is Rooks. I run the household.\n');
  const after = buildEffectivePrompt(agent, loadConfig(agent), backend);
  assert.match(after, /# Who you are\n\nMy name is Rooks\. I run the household\./);
  assert.match(after, /TECHNICAL INSTRUCTIONS/, 'system-prompt.md still carries the technical part');
  assert.ok(
    after.indexOf('# Who you are') < after.indexOf('# Role:'),
    'the identity the user chose frames the trade, not the other way round',
  );
});

test('soul.md in any case is the same file', () => {
  const agent = 'soul-case';
  upsertAgent({ name: agent, system_prompt: 'x', config: {} });
  writeFileSync(join(agentDir(agent), 'soul.md'), '  lowercase soul  ');
  assert.equal(loadSoul(agent), 'lowercase soul');
  assert.equal(loadSoul('SOUL-CASE'), 'lowercase soul', 'agent name resolution stays case-insensitive');
});

test('an agent without a directory has no soul rather than an error', () => {
  assert.equal(loadSoul('never-created'), '');
});
