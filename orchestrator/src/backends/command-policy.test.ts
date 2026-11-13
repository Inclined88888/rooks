/**
 * The product's command policy exists once, as data. grok and copilot write the
 * same decisions in their own rule syntax; this holds both to the neutral list,
 * so a provider written as a plugin that reads it enforces what they enforce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { COMMAND_POLICY } = await import('./command-policy.js');

const grok = readFileSync(new URL('../../official-providers/provider-grok/lib/grok.js', import.meta.url), 'utf8');
const copilot = readFileSync(new URL('../../official-providers/provider-copilot/lib/copilot.js', import.meta.url), 'utf8');

/** The quoted entries of `const <name>: readonly string[] = [ … ]`, comments and spreads aside. */
function listOf(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}`);
  assert.ok(start >= 0, `${name} not found`);
  const body = source.slice(source.indexOf('[', start), source.indexOf('];', start));
  return [...body.matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1]!);
}

const neutral = new Set<string>([...COMMAND_POLICY.denyCommands, ...COMMAND_POLICY.denyPrograms]);

test('every deny rule of grok is a decision of the neutral policy', () => {
  const rules = listOf(grok, 'GROK_DENY_RULES');
  assert.ok(rules.length >= 12, 'the fixture reads the real list');
  for (const rule of rules) {
    const command = /^Bash\((.+)\)$/.exec(rule)![1]!;
    const stem = command.replace(/ ?\*$/, '');
    const covered = neutral.has(command) || COMMAND_POLICY.denyPrograms.includes(stem)
      || COMMAND_POLICY.denyCommands.some((c) => c.replace(/\*$/, '') === command.replace(/\*$/, ''));
    assert.ok(covered, `${rule} is in grok but not in the neutral policy`);
  }
});

test('every plain deny rule of copilot is a decision of the neutral policy', () => {
  const rules = listOf(copilot, 'COPILOT_DENY_RULES');
  assert.ok(rules.length >= 8);
  for (const rule of rules) {
    const command = /^shell\((.+)\)$/.exec(rule)![1]!;
    const stem = command.replace(/:\*$/, '');
    const covered = COMMAND_POLICY.denyPrograms.includes(stem)
      || COMMAND_POLICY.denyCommands.some((c) => c.replace(/\*$/, '') === command)
      || COMMAND_POLICY.denyCommands.some((c) => c.replace(/\*$/, '') === stem);
    assert.ok(covered, `${rule} is in copilot but not in the neutral policy`);
  }
  // The `rooks …` rules are generated from the neutral list itself.
  assert.deepEqual(COMMAND_POLICY.denyRooksCommands, ['service', 'update', 'daemon', 'app restart']);
});

test('copilot reads its Rooks CLI commands from the neutral policy', () => {
  assert.match(copilot, /const ROOKS_CLI_COMMANDS = policy\.rooksCliCommands;/);
  assert.ok(COMMAND_POLICY.rooksCliCommands.includes('task done'));
  assert.equal(COMMAND_POLICY.rooksCliCommands.includes('service install'), false, 'the host operations stay out');
});

test('the policy is frozen', () => {
  assert.ok(Object.isFrozen(COMMAND_POLICY) && Object.isFrozen(COMMAND_POLICY.denyCommands));
});
