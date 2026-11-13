/**
 * TODO #523 — the reviewer briefs named `rooks task done --file`, a flag the
 * CLI never had. A reviewer that followed them failed its close, and the
 * verification loop read no verdict.
 *
 * The flags a brief gives for a long comment are checked against the usage
 * line of `orchestrator/bin/rooks` itself, so a brief and the CLI cannot drift
 * apart again; and a reviewer seeded before the fix (its `system-prompt.md` is
 * never rewritten) gets the corrected sentence at spawn.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

await import('../tests/helpers/claude-provider.js');

const { buildEffectivePrompt, loadConfig, upsertAgent } = await import('./agent.js');
const { getBackend } = await import('./backends/index.js');
const { getRole, updateRole, resetRoleDirectives, withCurrentCloseFlags } = await import('./agent-roles.js');
const { ensureProjectAgent } = await import('./agent-seed.js');
const { agentSystemPrompt } = await import('./paths.js');

const CLI = readFileSync(fileURLToPath(new URL('../bin/rooks', import.meta.url)), 'utf8');

function taskDoneFlags(): Set<string> {
  const usage = CLI.split('\n').find((l) => l.includes("usage: rooks task done <id>"));
  assert.ok(usage, 'the CLI still prints a usage line for `rooks task done`');
  return new Set(usage.match(/--[a-z][a-z-]*/g) ?? []);
}

/** Flags cited on the brief's "long comment" line, the one a reviewer follows to close. */
function longCommentFlags(brief: string): string[] {
  const line = brief.split('\n').find((l) => l.includes('Long comment') || l.includes('Comment long'));
  assert.ok(line, 'the brief still tells how to pass a long comment');
  return line.match(/--[a-z][a-z-]*/g) ?? [];
}

const LEGACY_SEED_LINE = '- Comment long → passe-le via `--file PATH` ou sur stdin, jamais en gros argument shell inline (le quoting peut tronquer le JSON et casser le parse du verdict).';
const LEGACY_ROLE_LINE = 'Comment long → `--file`/stdin, pas un gros arg shell.';

test('the CLI has no --file on task done, only --comment-file / --comment-stdin', () => {
  const flags = taskDoneFlags();
  assert.ok(flags.has('--comment-file'));
  assert.ok(flags.has('--comment-stdin'));
  assert.ok(!flags.has('--file'), 'if the CLI gains --file, this test and the briefs need revisiting');
});

test('the built-in reviewer role only cites flags `rooks task done` accepts', () => {
  const role = getRole('reviewer');
  assert.ok(role);
  const cited = longCommentFlags(role.default_directives);
  assert.ok(cited.length > 0);
  const accepted = taskDoneFlags();
  for (const flag of cited) assert.ok(accepted.has(flag), `${flag} is not a flag of rooks task done`);
});

test('a freshly seeded reviewer only cites flags `rooks task done` accepts', () => {
  assert.equal(ensureProjectAgent('acme523.reviewer', { slug: 'acme523', role: 'reviewer', cwd: process.env.ROOKS_HOME! }), true);
  const prompt = readFileSync(agentSystemPrompt('acme523.reviewer'), 'utf8');
  const cited = longCommentFlags(prompt);
  assert.ok(cited.length > 0);
  const accepted = taskDoneFlags();
  for (const flag of cited) assert.ok(accepted.has(flag), `${flag} is not a flag of rooks task done`);
});

test('a reviewer seeded before the fix is sent the corrected sentence, its file left as is', () => {
  const name = 'legacy523.reviewer';
  upsertAgent({ name, system_prompt: `# legacy reviewer\n\n${LEGACY_SEED_LINE}\n`, config: { role: 'reviewer' } });
  const prompt = buildEffectivePrompt(name, loadConfig(name), getBackend('claude'));
  assert.ok(!prompt.includes('`--file PATH`'), 'the stale flag no longer reaches the reviewer');
  assert.ok(!prompt.includes('`--file`/stdin'));
  assert.match(prompt, /passe-le via `--comment-file PATH` ou `--comment-stdin < PATH`/);
  assert.ok(
    readFileSync(agentSystemPrompt(name), 'utf8').includes(LEGACY_SEED_LINE),
    'system-prompt.md is never rewritten: it may carry the user\'s edits',
  );
});

test('a role override copied from the old default is corrected too', () => {
  updateRole('reviewer', { default_directives: `Tu audites du diff.\n${LEGACY_ROLE_LINE}` });
  try {
    upsertAgent({ name: 'override523', system_prompt: '# override\n', config: { role: 'reviewer' } });
    const prompt = buildEffectivePrompt('override523', loadConfig('override523'), getBackend('claude'));
    assert.ok(!prompt.includes('`--file`/stdin'));
    assert.match(prompt, /Comment long → `--comment-file PATH` ou `--comment-stdin < PATH`/);
  } finally {
    resetRoleDirectives('reviewer');
  }
});

test('only the exact stale sentences are rewritten', () => {
  const unrelated = 'rooks skill put my-skill --file PATH';
  assert.equal(withCurrentCloseFlags(unrelated), unrelated);
});
