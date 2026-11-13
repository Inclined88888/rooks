/** Windows command-line limits must not truncate a system prompt. */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const { mountOfficialProviders, buildUnderSeal } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();
async function promptFile(prompt: string): Promise<string> {
  const spawn = await buildUnderSeal('claude', { agentName: 'prompt-test', missionId: randomUUID(), cfg: {},
    systemPrompt: prompt, message: 'hi', resumeSession: null });
  assert.ok(!spawn.args.includes('--append-system-prompt'));
  return spawn.args[spawn.args.indexOf('--append-system-prompt-file') + 1]!;
}
test('a system prompt longer than the Windows command-line limit arrives intact', async () => {
  const prompt = 'x'.repeat(32_767 * 2);
  assert.equal(readFileSync(await promptFile(prompt), 'utf8'), prompt);
});
test('two missions have distinct prompt files and do not overwrite each other', async () => {
  const a = await promptFile('first');
  const b = await promptFile('second');
  assert.notEqual(a, b);
  assert.equal(readFileSync(a, 'utf8'), 'first');
  assert.equal(readFileSync(b, 'utf8'), 'second');
});
