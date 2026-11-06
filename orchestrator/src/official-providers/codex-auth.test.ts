/**
 * The sign-in check of the official Codex provider: what launches, what refuses before any CLI or
 * network, and what the doctor reports — through the real registry, the real seal and the real vault.
 */
import '../test-home.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getHost } from '../host/index.js';
import { TIMON_HOME } from '../paths.js';
import { config } from '../config/load.js';
import { dbApi } from '../db.js';
import { seal } from '../secrets/box.js';
import { resolveMasterKey } from '../secrets/key.js';
import type { ProfileRuntime } from '../backends/types.js';

const { mountOfficialProviders, buildDialectUnderSeal } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

const profile: ProfileRuntime = { id: 'codex', cmd: 'codex', env: {} };
function build(p = profile) {
  return buildDialectUnderSeal('codex', 'codex', p, { agentName: 'auth-test', missionId: randomUUID(),
    cfg: { cwd: TIMON_HOME, browser_profile_id: null }, systemPrompt: 'Test', message: 'Test', resumeSession: null });
}

function isolate(t: TestContext) {
  const before = { ...process.env };
  const inherit = config().secrets.inheritEnv;
  config().secrets.inheritEnv = false;
  t.after(() => { config().secrets.inheritEnv = inherit; });
  process.env.CODEX_AUTH_DIR = join(TIMON_HOME, randomUUID());
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
  t.after(() => { process.env = before; });
  t.mock.method(getHost(), 'exec', () => { throw new Error('unexpected process'); });
  const cliCheck = t.mock.method(getHost(), 'execAsync', () => { throw new Error('unexpected CLI check'); });
  t.after(() => assert.equal(cliCheck.mock.callCount(), 0));
  const spawn = t.mock.method(getHost(), 'spawn', () => { throw new Error('unexpected spawn'); });
  t.after(() => assert.equal(spawn.mock.callCount(), 0));
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network'); });
  t.after(() => assert.equal(fetch.mock.callCount(), 0));
}

test('TIM-0018: missing credentials refuse launch before CLI checks or network', async (t) => {
  isolate(t);
  await assert.rejects(build({ ...profile, minCliVersion: '1.0.0' }), (error: Error) => {
    assert.match(error.message, /Codex is not connected/);
    assert.match(error.message, /codex login/);
    assert.ok(error.message.includes(join(process.env.CODEX_AUTH_DIR!, 'auth.json')));
    return true;
  });
});

test('readable auth.json is exposed to the mission unchanged', async (t) => {
  isolate(t);
  mkdirSync(process.env.CODEX_AUTH_DIR!);
  process.env.OPENAI_API_KEY = 'unrelated-openai-key';
  const content = JSON.stringify({ tokens: { access_token: 'fake', refresh_token: 'fake' } });
  writeFileSync(join(process.env.CODEX_AUTH_DIR!, 'auth.json'), content);
  const spec = await build();
  assert.equal(spec.env?.CODEX_API_KEY, undefined, 'preserve subscription login over a generic API key');
  assert.equal(readFileSync(join(spec.env!.CODEX_HOME!, 'auth.json'), 'utf8'), content);
});

for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY']) {
  test(`${key} explicitly inherited permits launch without auth.json`, async (t) => {
    isolate(t);
    process.env[key] = 'test-only-key';
    config().secrets.inheritEnv = true;
    const spec = await build();
    assert.equal(spec.env?.CODEX_API_KEY, 'test-only-key');
    assert.ok(!spec.args.join(' ').includes('test-only-key'));
  });
}

test('custom provider keeps its own authentication', async (t) => {
  isolate(t);
  await build({ ...profile, providerConfig: { id: 'custom', name: 'Custom', baseUrl: 'https://example.invalid', envKey: 'CUSTOM_KEY', wireApi: 'responses' }, env: { CUSTOM_KEY: 'fake' } });
});

/** The doctor's report for the codex provider (C4). */
function codexAuth(report: { auth: Array<{ provider: string; ok: boolean; detail: string; path: string | null }> }) {
  return report.auth.find((entry) => entry.provider === 'codex')!;
}

test('doctor reports the same missing credentials and the resolved path without secrets', async (t) => {
  isolate(t);
  const { diagnose, formatDoctor } = await import('../doctor.js');
  t.mock.restoreAll();
  const report = diagnose();
  assert.equal(codexAuth(report).ok, false);
  assert.equal(codexAuth(report).path, join(process.env.CODEX_AUTH_DIR!, 'auth.json'));
  assert.match(formatDoctor(report), /Codex credentials MISSING/);
  process.env.OPENAI_API_KEY = 'never-print-this';
  assert.equal(codexAuth(diagnose()).ok, false);
  config().secrets.inheritEnv = true;
  const ready = diagnose();
  assert.match(codexAuth(ready).detail, /API key available/);
  assert.ok(!JSON.stringify(ready).includes('never-print-this'));
});

test('missing login never spawns a process or cools down the provider', async (t) => {
  isolate(t);
  const { upsertAgent, spawnAgent } = await import('../agent.js');
  const { isBackendCoolingDown } = await import('../backend-fallback.js');
  upsertAgent({ name: 'auth-test', system_prompt: 'Test', config: {
    backend: 'codex', cwd: TIMON_HOME, browser_profile_id: null, skills: [], mcp_servers: [],
  } });
  for (let i = 0; i < 4; i++) {
    await assert.rejects(spawnAgent('auth-test', 'Test'), /Codex is not connected/);
  }
  assert.equal(isBackendCoolingDown('codex'), false);
});

for (const state of ['empty', 'directory']) {
  test(`${state} auth.json is not usable without a key`, async (t) => {
    isolate(t);
    mkdirSync(process.env.CODEX_AUTH_DIR!);
    const path = join(process.env.CODEX_AUTH_DIR!, 'auth.json');
    if (state === 'directory') mkdirSync(path);
    else writeFileSync(path, '');
    await assert.rejects(build(), /Codex is not connected/);
    config().secrets.inheritEnv = true;
    process.env.OPENAI_API_KEY = 'test-key';
    assert.ok((await build()).env?.CODEX_API_KEY);
  });
}

for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY']) {
  test(`${key} in daemon alone cannot bypass secret grants`, async (t) => {
    isolate(t);
    process.env[key] = 'daemon-only-secret';
    await assert.rejects(build(), /Codex is not connected/);
    mkdirSync(process.env.CODEX_AUTH_DIR!);
    writeFileSync(join(process.env.CODEX_AUTH_DIR!, 'auth.json'), '{"tokens":{"access_token":"fake"}}');
    assert.equal((await build()).env?.CODEX_API_KEY, undefined);
  });
}

test('an inject secret granted to the agent permits launch without inheritance', async (t) => {
  isolate(t);
  const name = 'OPENAI_API_KEY';
  const row = dbApi.createSecret({ name, value_enc: 'placeholder', mode: 'inject' });
  t.after(() => dbApi.deleteSecret(row.id));
  dbApi.updateSecret(row.id, { value_enc: seal('granted-test-key', resolveMasterKey({ keyring: null }), { secretId: row.id, name }) });
  await assert.rejects(build(), /Codex is not connected/);
  const { diagnose } = await import('../doctor.js');
  t.mock.method(getHost(), 'exec', () => ({ code: 1, stdout: '', stderr: 'unavailable in test' }));
  const { setMainAgentName, MAIN_AGENT_KEY } = await import('../main-agent.js');
  const previousMain = dbApi.getAllSettings()[MAIN_AGENT_KEY];
  setMainAgentName('auth-test');
  t.after(() => dbApi.setSetting(MAIN_AGENT_KEY, previousMain ?? ''));
  assert.equal(codexAuth(diagnose()).ok, false);
  dbApi.addSecretGrant(row.id, 'agent', 'auth-test');
  assert.match(codexAuth(diagnose()).detail, /API key available/);
  assert.equal((await build()).env?.CODEX_API_KEY, 'granted-test-key');
});

test('every keyring sign-in hint gives the command the provider itself runs', () => {
  // Two spellings with different quoting survived side by side in the docs and
  // the messages (TODO #546); the unquoted one is what `login.js` passes to
  // codex and the only one every shell (PowerShell, cmd, Bash) reads the same.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const repo = join(here, '..', '..', '..');
  const provider = join(repo, 'orchestrator', 'official-providers', 'provider-codex', 'lib');
  assert.match(readFileSync(join(provider, 'login.js'), 'utf8'), /'-c', 'cli_auth_credentials_store=file'/);
  const sources = [
    join(provider, 'auth.js'),
    join(provider, 'usage.js'),
    join(repo, 'public-docs', 'docs', 'installation', 'troubleshooting.md'),
  ];
  for (const file of sources) {
    const commands = readFileSync(file, 'utf8').match(/codex -c \S*cli_auth_credentials_store\S* login/g) ?? [];
    assert.ok(commands.length > 0, `${file} names no keyring sign-in command`);
    for (const command of commands) assert.equal(command, 'codex -c cli_auth_credentials_store=file login', file);
  }
});
