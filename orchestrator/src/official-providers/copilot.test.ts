/**
 * The official Copilot provider, run the way a third party's would be: its `apply(ctx)` against the
 * stand-in `ctx` of `@rooks/sdk/testing`, then the conformance bench of the SDK on what it
 * registered. What the generic bench cannot see is here: the channels of the system prompt and the
 * message, the MCP file, the translation of the permission mode, the stream edge cases.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildSpawnOpts, NativeProviderDefinition, ProfileRuntime } from '../backends/types.js';

const kit = await import('../../../packages/sdk/src/testing/index.js');
const { providerRuntime } = await import('../backends/provider-runtime.js');
const { COMMAND_POLICY } = await import('../backends/command-policy.js');
const plugin = await import('../../official-providers/provider-copilot/lib/index.js') as { apply(ctx: unknown): void };
const { ALLOWLIST_REFUSAL_TEXT, copilotRules, createEventMapper } = await import('../../official-providers/provider-copilot/lib/copilot.js') as {
  ALLOWLIST_REFUSAL_TEXT: string;
  copilotRules(policy: typeof COMMAND_POLICY, formsServer: string): {
    permissionArgs(mode: string | undefined, servers: readonly string[], allowed?: readonly string[]): string[];
    shellGrantsFromAllowedTools(allowed: readonly string[] | undefined): string[];
  };
  createEventMapper(events: typeof providerRuntime.events): (raw: unknown) => import('../backends/types.js').NormalizedEvent[];
};
const { modelIdsFromSessionNew } = await import('../backends/model-ids.js');

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-copilot-plugin-'));
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const ctx = kit.createProviderContext();
plugin.apply(ctx);
const provider = ctx.registered.providers.get('copilot') as NativeProviderDefinition & { launch(spawn: BuildSpawnOpts, profile: ProfileRuntime): Promise<{ cmd: string; args: string[]; cwd?: string; env?: Record<string, string>; initialStdin: string | null }> };
const dialect = ctx.registered.dialect('copilot') as import('../backends/types.js').Dialect;
const mapCopilotEvent = createEventMapper(providerRuntime.events);
const copilot = copilotRules(COMMAND_POLICY, 'nova_ask');
process.on('exit', () => ctx.cleanup());

const PROFILE: ProfileRuntime = { id: 'copilot', cmd: 'copilot', env: {} };
const SYSTEM_PROMPT = 'You are a Rooks agent. Answer in French.';
const MESSAGE = 'Summarise src/index.ts.';

function opts(over: Partial<BuildSpawnOpts> = {}, cfg: Partial<BuildSpawnOpts['cfg']> = {}): BuildSpawnOpts {
  return {
    agentName: 'rooks.copilot-test',
    systemPrompt: SYSTEM_PROMPT,
    message: MESSAGE,
    resumeSession: null,
    cfg: { cwd: TMP_HOME, model: 'auto', permission_mode: 'auto', ...cfg },
    missionId: `mission-${Math.random().toString(36).slice(2, 10)}`,
    ...over,
  };
}

function argAfter(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : null;
}

test('the provider registers under the product\'s own id, and what it declares matches the product\'s table', async () => {
  const { BUILTIN_DECLARATIONS } = await import('../backends/builtin-declarations.js');
  assert.equal(provider.id, 'copilot');
  const declared = BUILTIN_DECLARATIONS.copilot!;
  // `folderPattern` narrows a desktop build and `standaloneInstaller` is what the provider cards may
  // run: both are the product's own, a plugin's value for them is never read.
  const publicOnly = JSON.parse(JSON.stringify(declared.binary, (key, value) => (key === 'folderPattern' || key === 'standaloneInstaller' ? undefined : value)));
  assert.deepEqual(JSON.parse(JSON.stringify(provider.declares?.binary)), publicOnly, 'binary (C1)');
  assert.deepEqual(provider.declares?.credentialDirs, declared.credentialDirs, 'credentialDirs (C2)');
  assert.equal(provider.declares?.spans, 'stream-json');
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'official-providers', 'provider-copilot', 'package.json'), 'utf8')) as {
    rooks: { provider: { binaries: Array<{ name: string }>; credentialDirs: string[] } };
  };
  assert.deepEqual(manifest.rooks.provider.binaries.map((b) => b.name), [...(provider.declares?.binary?.names ?? [])]);
  assert.deepEqual(manifest.rooks.provider.credentialDirs, [...(provider.declares?.credentialDirs ?? [])]);
});

test('system prompt goes to a custom-instructions file, the message to stdin', async () => {
  const sp = await provider.launch(opts(), PROFILE);
  assert.ok(!sp.args.some((a) => a.includes(SYSTEM_PROMPT) || a.includes(MESSAGE)), 'prompt in argv');
  assert.equal(sp.initialStdin, MESSAGE);
  const dir = sp.env!.COPILOT_CUSTOM_INSTRUCTIONS_DIRS!;
  const file = readFileSync(join(dir, 'instructions', 'rooks.instructions.md'), 'utf8');
  // Without `applyTo`, an .instructions.md file is scoped to matching paths.
  assert.match(file, /^---\napplyTo: "\*\*"\n---\n/);
  assert.ok(file.includes(SYSTEM_PROMPT));
});

test('Rooks MCP servers carry the mission identity and every tool', async () => {
  const o = opts();
  const sp = await provider.launch(o, PROFILE);
  const ref = argAfter(sp.args, '--additional-mcp-config');
  assert.ok(ref?.startsWith('@'), '--additional-mcp-config must point at a file');
  const config = JSON.parse(readFileSync(ref!.slice(1), 'utf8')) as {
    mcpServers: Record<string, { type?: string; tools?: string[]; env?: Record<string, string> }>;
  };
  for (const name of ['rooks', 'nova_ask']) {
    const server = config.mcpServers[name];
    assert.ok(server, `${name} missing`);
    assert.equal(server.type, 'local');
    assert.deepEqual(server.tools, ['*']);
    assert.equal(server.env?.ROOKS_MISSION_ID, o.missionId);
    assert.equal(server.env?.ROOKS_AGENT, o.agentName);
    assert.equal(server.env?.ROOKS_ORCH_URL, 'http://127.0.0.1:3001');
    // A reference the CLI expands, never the token itself.
    assert.equal(server.env?.ROOKS_API_TOKEN, '${ROOKS_API_TOKEN}');
  }
  assert.ok(sp.args.includes('--disable-builtin-mcps'));
  assert.ok(sp.args.includes('--no-ask-user'));
});

test('plan mode reads but neither writes, runs a shell nor fetches', async () => {
  const sp = await provider.launch(opts({}, { permission_mode: 'plan' }), PROFILE);
  assert.ok(!sp.args.includes('--allow-all-tools'));
  assert.ok(sp.args.includes('--allow-tool=read'));
  assert.ok(sp.args.includes('--allow-tool=rooks'));
  for (const kind of ['write', 'shell', 'url', 'memory']) assert.ok(sp.args.includes(`--deny-tool=${kind}`), kind);
});

/**
 * The CLI's shell-rule matching as documented (`copilot help permissions`,
 * "Tool permission patterns"), read as PERMISSIVELY as the text allows: an
 * exact rule `shell(git status)` is taken to match any arguments after it too.
 * A command this model refuses is refused by the real CLI, whose matching can
 * only be stricter. Deny wins over allow; every simple command of a chain or a
 * pipeline must pass; a command naming a URL also needs a URL permission.
 */
function shellAllowed(args: string[], commandLine: string): boolean {
  const allows = args.filter((a) => a.startsWith('--allow-tool=')).map((a) => a.slice('--allow-tool='.length));
  const denies = args.filter((a) => a.startsWith('--deny-tool=')).map((a) => a.slice('--deny-tool='.length));
  const allTools = args.some((a) => a === '--allow-all-tools' || a === '--allow-all' || a === '--yolo');
  const allUrls = args.some((a) => a === '--allow-all-urls' || a === '--allow-all' || a === '--yolo')
    || allows.some((r) => r === 'url' || r.startsWith('url('))
    || args.some((a) => a.startsWith('--allow-url'));
  const matches = (rule: string, cmd: string): boolean => {
    if (rule === 'shell') return true;
    const m = /^shell\((.+)\)$/.exec(rule);
    if (!m) return false;
    const body = m[1]!.endsWith(':*') ? m[1]!.slice(0, -2) : m[1]!;
    return cmd === body || cmd.startsWith(`${body} `);
  };
  if (/[a-z]+:\/\//i.test(commandLine) && !allUrls) return false;
  return commandLine.split(/&&|\|\||;|\|/).map((c) => c.trim()).filter(Boolean).every((cmd) =>
    !denies.some((r) => matches(r, cmd)) && (allTools || allows.some((r) => matches(r, cmd))));
}

/** What a real `code` task on copilot carries: the dispatcher's grants for the
 *  type plus the `rooks-task` and `rooks-worktree` skills'. */
const CODE_TASK_GRANTS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git:*)', 'Bash(npx tsc:*)', 'Bash(npm run:*)',
  'Bash(rooks:*)', 'mcp__nova__kanban_mark_as_done',
];

const SANDBOXED_MODES = ['auto', 'default', 'acceptEdits', undefined] as const;

test('sandboxed modes hand out an allowlist, never a blanket permission', async () => {
  for (const mode of SANDBOXED_MODES) {
    const sp = await provider.launch(
      opts({}, { permission_mode: mode, allowed_tools: CODE_TASK_GRANTS }), PROFILE);
    const label = String(mode);
    for (const flag of ['--allow-all-tools', '--allow-all-urls', '--allow-all-paths', '--allow-all', '--yolo']) {
      assert.ok(!sp.args.includes(flag), `${label}: ${flag}`);
    }
    assert.ok(!sp.args.some((a) => a.startsWith('--allow-url')), `${label}: --allow-url`);
    assert.ok(!sp.args.includes('--allow-tool=shell'), `${label}: generic shell`);
    assert.ok(!sp.args.some((a) => a.startsWith('--allow-tool=url')), `${label}: url rule`);
    assert.ok(!sp.args.includes('--allow-tool=shell(git:*)'), `${label}: git:* opens git -c`);
    for (const allowed of ['read', 'write', 'rooks', 'nova_ask']) {
      assert.ok(sp.args.includes(`--allow-tool=${allowed}`), `${label}: ${allowed}`);
    }
    assert.ok(sp.args.includes('--deny-tool=shell(sudo:*)'), label);
  }
});

test('auto refuses the commands that get around the deny rules', async () => {
  const sp = await provider.launch(
    opts({}, { permission_mode: 'auto', allowed_tools: CODE_TASK_GRANTS }), PROFILE);
  const refused = [
    // Variants the deny list alone would let through.
    'sudo -n true', 'rm -fr /', 'rm -rf / --no-preserve-root', 'rm -rf $HOME',
    'systemctl --user restart rooks-orchestrator.service', 'systemctl --user kill rooks-orchestrator',
    // A shell or an interpreter under another name.
    'bash -c "sudo reboot"', 'sh -c id', 'env sudo ls', 'xargs rm', 'nohup reboot',
    'node -e "require(\'child_process\').execSync(\'id\')"', 'python3 -c "import os"',
    'npx cowsay', 'npm exec cowsay', 'npm --prefix /etc run x',
    // git's own escape hatches, although the task was granted `Bash(git:*)`.
    "git -c alias.x='!sh -c id' x", 'git config alias.x "!sh"', 'git grep -O"sh -c id" x',
    // Read commands that start a program, writers of arbitrary files.
    'rg --pre bash x', 'sort --compress-program=sh f', 'find / -delete', 'sed -i s/a/b/ f', 'tee f',
    // The network, and chains that smuggle one of the above.
    'curl https://example.com', 'wget http://example.com', 'cat https://example.com/x',
    'git status && bash -c id', 'ls | sh',
    // Rooks's host operations, although the task was granted `Bash(rooks:*)`.
    'rooks service install', 'rooks service uninstall', 'rooks service', 'rooks update approve 9.9.9',
    'rooks app restart', 'rooks daemon', 'rooks plugin add evil-plugin', 'rooks auth login', 'rooks secret set X',
    'rooks user list', 'rooks backup', 'rooks import dump.json', 'rooks task delete 1', 'rooks worktree dispose 1',
    'rooks --daemon other task list', 'rooks task list && rooks service uninstall',
  ];
  for (const command of refused) assert.equal(shellAllowed(sp.args, command), false, command);

  const permitted = [
    'git status', 'git commit -m "feat: x"', 'git merge --no-ff rooks/task/1', 'rooks task done 1 --comment ok',
    'ls -la', 'npx tsc --noEmit', 'npm run typecheck', 'git diff main...HEAD | head -50',
    'rooks task list', 'rooks task done 1 --comment-file /tmp/verdict.md', 'rooks notify report "done"',
    'rooks msg send a.main "hi"', 'rooks memory rule add "x"', 'rooks workflow node done --output {}',
    'rooks spawn a.main "brief"', 'rooks list',
  ];
  for (const command of permitted) assert.equal(shellAllowed(sp.args, command), true, command);
});

test('without any grant, auto still keeps git read-only commands and the rooks CLI only', async () => {
  const sp = await provider.launch(opts({}, { permission_mode: 'auto' }), PROFILE);
  assert.equal(shellAllowed(sp.args, 'git log --oneline'), true);
  assert.equal(shellAllowed(sp.args, 'rooks task list'), true);
  assert.equal(shellAllowed(sp.args, 'rooks service install'), false);
  assert.ok(!sp.args.some((a) => a === '--allow-tool=shell(rooks:*)' || a === '--allow-tool=shell(rooks)'));
  assert.equal(shellAllowed(sp.args, 'git push origin main'), false);
  assert.equal(shellAllowed(sp.args, 'npm run build'), false);
});

test('claude-format grants translate, generic shells do not', () => {
  const grants = copilot.shellGrantsFromAllowedTools([
    'Bash(npm run:*)', 'Bash(npx tsc:*)', 'Bash(git diff:*)', 'Bash(make test)',
    'Bash', 'Bash(*)', 'Bash(bash:*)', 'Bash(env:*)', 'Bash(node *)', 'Bash(npx:*)', 'Bash(npm *)',
    'Bash(git -c:*)', 'Bash(ls; sh:*)', 'Read', 'Edit', 'mcp__nova__kanban_add',
  ]);
  assert.deepEqual(grants, [
    'shell(npm run:*)', 'shell(npx tsc:*)', 'shell(git diff:*)', 'shell(make test)',
  ]);
  const git = copilot.shellGrantsFromAllowedTools(['Bash(git:*)']);
  assert.ok(git.includes('shell(git commit)') && git.includes('shell(git merge)'));
  assert.ok(!git.some((r) => r === 'shell(git:*)' || r.includes('config')));
});

test('a rooks grant opens the named Rooks commands, never the CLI as a whole', () => {
  for (const broad of ['Bash(rooks:*)', 'Bash(rooks *)']) {
    const rules = copilot.shellGrantsFromAllowedTools([broad]);
    assert.ok(rules.includes('shell(rooks task done:*)') && rules.includes('shell(rooks msg send:*)'), broad);
    assert.ok(!rules.some((r) => r === 'shell(rooks:*)' || r === 'shell(rooks)'), broad);
    assert.ok(!rules.some((r) => /rooks (service|update|plugin|auth|secret|user|backup|import|daemon)\b/.test(r)), broad);
  }
  const task = copilot.shellGrantsFromAllowedTools(['Bash(rooks task:*)']);
  assert.ok(task.length > 0 && task.every((r) => r.startsWith('shell(rooks task ')));
  assert.ok(!task.some((r) => r.includes('delete')));
  assert.deepEqual(copilot.shellGrantsFromAllowedTools(['Bash(rooks workflow node done *)']), ['shell(rooks workflow node done:*)']);
  assert.deepEqual(copilot.shellGrantsFromAllowedTools([
    'Bash(rooks service:*)', 'Bash(rooks service install)', 'Bash(rooks plugin *)', 'Bash(rooks)', 'Bash(rooks --daemon:*)',
  ]), []);
});

test('workspace allows the mission MCP servers, plan only the Rooks bridge', async () => {
  assert.ok(copilot.permissionArgs('auto', ['rooks', 'nova_ask', 'my-db']).includes('--allow-tool=my-db'));
  assert.ok(!copilot.permissionArgs('plan', ['rooks', 'nova_ask', 'my-db']).includes('--allow-tool=my-db'));
});

test('bypassPermissions is the one unsandboxed mode, the deny rules still hold', async () => {
  for (const mode of ['bypassPermissions', 'danger-full-access']) {
    const sp = await provider.launch(opts({}, { permission_mode: mode }), PROFILE);
    assert.ok(sp.args.includes('--allow-all-tools'), mode);
    assert.ok(sp.args.includes('--allow-all-urls'), mode);
    assert.ok(sp.args.includes('--deny-tool=shell(sudo:*)'), mode);
    assert.ok(sp.args.includes('--deny-tool=shell(systemctl --user restart rooks-orchestrator)'), mode);
    for (const command of ['rooks service install', 'rooks service uninstall', 'rooks update approve 9.9.9']) {
      assert.equal(shellAllowed(sp.args, command), false, `${mode}: ${command}`);
    }
    assert.equal(shellAllowed(sp.args, 'sudo ls'), false, mode);
  }
});

test('resume passes the id as its own argument, never a bare --resume', async () => {
  const sp = await provider.launch(opts({ resumeSession: 'abc-123' }), PROFILE);
  assert.equal(argAfter(sp.args, '--resume'), 'abc-123');
});

test('images become attachments on disk', async () => {
  const png = { media_type: 'image/png', data: Buffer.from('x').toString('base64') };
  const sp = await provider.launch(opts({ images: [png] }), PROFILE);
  const file = argAfter(sp.args, '--attachment');
  assert.ok(file && file.endsWith('.png') && existsSync(file));
});

test('the session-not-found message the CLI really prints is recognised', () => {
  assert.equal(dialect.isSessionNotFoundError!(
    "Error: No session, task, or name matched '0b6f3c1e-1111-4222-8333-944455556666'.",
  ), true);
  assert.equal(dialect.isSessionNotFoundError!('Error: Access denied by policy settings'), false);
});

test('session.error becomes an error result carrying its HTTP status', () => {
  const [ev] = mapCopilotEvent({
    type: 'session.error', data: { errorType: 'rate_limit', message: 'Too many requests', statusCode: 429 },
  });
  assert.equal(ev?.type, 'result');
  const p = ev!.payload as Record<string, unknown>;
  assert.equal(p.is_error, true);
  assert.equal(p.subtype, 'error');
  assert.equal(p.api_error_status, 429);
});

test('a failed run announces its session without a second result', () => {
  const events = mapCopilotEvent({ type: 'result', sessionId: 's-1', exitCode: 1, usage: {} });
  assert.deepEqual(events.map((e) => e.type), ['system']);
});

test('a failed tool is reported as an error result', () => {
  const [ev] = mapCopilotEvent({
    type: 'tool.execution_complete', data: { toolCallId: 't1', success: false, error: { message: 'denied' } },
  });
  const block = (ev!.payload as { message: { content: Array<Record<string, unknown>> } }).message.content[0]!;
  assert.equal(block.is_error, true);
  assert.equal(block.content, 'denied');
});

test('an allowlist refusal reads as one, never as a call to retry interactively (TIM-0063)', () => {
  // The sentence the tester saw, as the CLI prints it under --no-ask-user.
  const cli = 'Permission denied because no interactive user response was available. Retry in an interactive '
    + 'session so the user can approve it, or try an alternative that does not require this permission.';
  for (const data of [
    { toolCallId: 't1', success: false, error: { message: cli } },
    { toolCallId: 't1', success: false, result: { content: cli } },
  ]) {
    const [ev] = mapCopilotEvent({ type: 'tool.execution_complete', data });
    const block = (ev!.payload as { message: { content: Array<Record<string, unknown>> } }).message.content[0]!;
    assert.equal(block.is_error, true);
    const text = String(block.content);
    assert.ok(text.startsWith(ALLOWLIST_REFUSAL_TEXT), text);
    assert.match(text, /allowed tools/);
    assert.ok(text.endsWith(cli), 'the CLI sentence stays searchable');
  }
});

test('the backend block warns the model that a Copilot refusal is final', () => {
  assert.match(dialect.permissionsHint ?? '', /no interactive user response was available/);
  assert.match(dialect.permissionsHint ?? '', /nobody can approve it/);
});

test("a sub-agent's inner stream stays out of the transcript", () => {
  assert.deepEqual(mapCopilotEvent({
    type: 'assistant.message', agentId: 'sub-1', data: { messageId: 'm', content: 'inner' },
  }), []);
});

test('model ids are read from both session/new shapes', () => {
  assert.deepEqual(modelIdsFromSessionNew({
    sessionId: 's', models: { currentModelId: 'auto', availableModels: [{ modelId: 'auto', name: 'Auto' }, { modelId: 'gpt-5.4' }] },
  }), ['auto', 'gpt-5.4']);
  assert.deepEqual(modelIdsFromSessionNew({
    configOptions: [{ id: 'model', category: 'model', options: [{ value: 'claude-sonnet-4.6' }] }],
  }), ['claude-sonnet-4.6']);
  assert.deepEqual(modelIdsFromSessionNew({ sessionId: 's' }), []);
});


/* ── The conformance bench of the SDK, on the recorded (documented-schema) turn ────────────── */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'backends', '__fixtures__', 'copilot.jsonl');
const benchScratch = await ctx.provider.scratch.mission({ ...opts(), missionId: kit.DEFAULT_MISSION_ID });

kit.defineConformanceTests(test, kit.dialectConformance(
  dialect,
  { id: 'copilot', env: {} },
  {
    // Assembled from the Copilot SDK's session-events reference, not captured from a live turn
    // (no Copilot seat to capture one).
    transcript: readFileSync(FIXTURE, 'utf8'),
    sessionId: '4dedd90b-f6fb-49ce-938f-4d74497ad7bf',
    cmd: 'copilot',
    // The system prompt's channel: a custom-instructions directory per mission.
    envKeys: ['COPILOT_CUSTOM_INSTRUCTIONS_DIRS'],
    model: 'claude-sonnet-4.6',
    initAt: 'result',
  },
  { cwd: TMP_HOME, scratchDirs: [benchScratch.path] },
), '[copilot plugin]');

test('a read-only-tools launch denies read, write, shell and URL whatever the mode, and keeps the mission\'s MCP servers (TODO #469, #471)', async () => {
  for (const permission_mode of ['auto', 'bypassPermissions']) {
    const sp = await provider.launch({ ...opts({}, { permission_mode }), readOnlyTools: true }, PROFILE);
    assert.ok(!sp.args.includes('--allow-all-tools'), permission_mode);
    assert.ok(!sp.args.includes('--allow-tool=write'), permission_mode);
    assert.ok(!sp.args.some((arg) => /^--allow-tool=shell/.test(arg)), permission_mode);
    for (const kind of ['read', 'write', 'shell', 'url', 'memory']) assert.ok(sp.args.includes(`--deny-tool=${kind}`), `${permission_mode}: ${kind}`);
    assert.equal(sp.args.includes('--allow-tool=read'), false, permission_mode);
    assert.ok(sp.args.includes('--allow-tool=rooks'));
  }
  const ordinary = await provider.launch(opts({}, { permission_mode: 'auto' }), PROFILE);
  assert.ok(ordinary.args.includes('--allow-tool=write'), 'an ordinary mission keeps its workspace');
});
