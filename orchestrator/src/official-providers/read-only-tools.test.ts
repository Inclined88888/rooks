/**
 * `BuildSpawnOpts.readOnlyTools` on the claude dialect, built the way the daemon builds it (TODO #469,
 * #471): the built-in set is emptied, so neither `Bash` nor `Write` nor `Read` nor a tool a later CLI
 * adds is there, the agent's own grants cannot bring one back, and only `--mcp-config` servers load.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const { mountOfficialProviders, buildUnderSeal } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { TIMON_HOME } = await import('../paths.js');
const { BUILTIN_DECLARATIONS } = await import('../backends/builtin-declarations.js');
const cwd = join(TIMON_HOME, 'project');
mkdirSync(cwd, { recursive: true });

const build = (missionId: string, cfg: Record<string, unknown>, readOnlyTools?: boolean) => buildUnderSeal('claude', {
  agentName: 'reader', missionId, systemPrompt: 'Prompt.', message: 'Hello.', resumeSession: null,
  cfg: { cwd, ...cfg }, ...(readOnlyTools === undefined ? {} : { readOnlyTools }),
});

/** Every `--tools` of a launch, in either spelling (`--tools a,b`, `--tools=a,b`). */
const toolsArgs = (args: readonly string[]): string[] => args.flatMap((arg, i) => {
  if (arg.startsWith('--tools=')) return [arg.slice('--tools='.length)];
  return arg === '--tools' ? [args[i + 1] ?? ''] : [];
});

test('a read-only-tools claude launch offers no built-in tool, file readers included, whatever the mode and the grants', async () => {
  for (const permission_mode of ['auto', 'bypassPermissions', 'acceptEdits']) {
    const spawn = await build(`ro-${permission_mode}`, { permission_mode, allowed_tools: ['Bash(timon:*)', 'Write', 'Edit', 'Read'] }, true);
    assert.deepEqual(toolsArgs(spawn.args), [''], permission_mode);
    // One argument: a separate `""` would be dropped by a Windows `.cmd` shim, and the variadic
    // `--tools` would then swallow whatever comes next.
    assert.ok(spawn.args.includes('--tools='));
    assert.equal(spawn.args.includes('--tools'), false);
    assert.match(spawn.args[spawn.args.indexOf('--tools=') + 1] ?? '--', /^--/);
    // The user's, the project's and the account's servers stay out: only `--mcp-config` loads.
    assert.ok(spawn.args.includes('--strict-mcp-config'), permission_mode);
    assert.ok(spawn.args.includes('--mcp-config'));
  }
});

test('an ordinary claude launch keeps the default built-in set and its other MCP servers', async () => {
  for (const spawn of [await build('ordinary', { permission_mode: 'auto' }), await build('ordinary-false', { permission_mode: 'auto' }, false)]) {
    assert.deepEqual(toolsArgs(spawn.args), []);
    assert.equal(spawn.args.includes('--strict-mcp-config'), false);
  }
});

test('the product declares readOnlyTools for the dialects that honour it, and for no other', () => {
  const declaring = Object.entries(BUILTIN_DECLARATIONS).filter(([, d]) => d.readOnlyTools === true).map(([id]) => id).sort();
  assert.deepEqual(declaring, ['claude', 'codex', 'copilot']);
});
