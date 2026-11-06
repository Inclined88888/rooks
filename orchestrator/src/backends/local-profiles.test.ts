/**
 * User-added backends (`~/.timon/backends/*.json`) — what a data file may
 * say, what it may not, and that the registry follows the folder.
 *
 * The refusals matter more than the loading: this folder takes unsigned files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-local-backends-'));
process.env.TIMON_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { parseLocalBackend, parsePackBackend, reloadLocalBackends, listLocalBackends, NO_KEY_PLACEHOLDER } = await import('./local-profiles.js');
const { forbiddenEnvReason, FORBIDDEN_ENV_NAMES, FORBIDDEN_ENV_PREFIXES } = await import('./env-guard.js');
const { localEnvReason } = await import('./local-env.js');
const { getDialect, registerDialect, registerFileProfile, registerPackProfile } = await import('./registry.js');
const { isBackendName, inactiveProfiles, backendCatalog } = await import('./index.js');
const { onBackendsChanged, activeProfiles } = await import('./registry.js');

const DIR = join(TMP_HOME, 'backends');
mkdirSync(DIR, { recursive: true });

const valid = {
  id: 'acme',
  dialect: 'claude',
  label: 'Acme',
  env: { ANTHROPIC_BASE_URL: 'https://llm.acme.test/anthropic', ANTHROPIC_AUTH_TOKEN: NO_KEY_PLACEHOLDER },
  defaultModel: 'acme-1',
  models: [{ slug: 'acme-1', label: 'Acme 1' }],
};

function drop(name: string, content: unknown): void {
  writeFileSync(join(DIR, name), typeof content === 'string' ? content : JSON.stringify(content));
}

function clear(): void {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  reloadLocalBackends();
}

{
  const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

for (const key of ['cmd', 'requiredBinary', 'requiredEnv', 'envFrom']) {
  test(`a file naming \`${key}\` is refused, with the reason`, () => {
    const out = parseLocalBackend({ ...valid, [key]: key.startsWith('required') && key !== 'requiredBinary' ? ['HOME'] : 'sh' });
    assert.equal(out.ok, false);
    assert.match((out as { reason: string }).reason, new RegExp(`\`${key}\` is not allowed`));
  });
}

test('an unknown key is refused: the schema is strict', () => {
  assert.equal(parseLocalBackend({ ...valid, minCliVersion: '0.0.1' }).ok, false);
  assert.equal(parseLocalBackend({ ...valid, modelsEndpoint: { url: 'https://a.test/v1/models', format: 'openai', authFrom: { Authorization: 'HOME' } } }).ok, false);
});

test('a base URL that is not http(s) is refused', () => {
  const out = parseLocalBackend({
    ...valid, dialect: 'codex',
    providerConfig: { id: 'timon-acme', name: 'Acme', baseUrl: 'file:///etc/passwd', envKey: 'ACME_KEY', wireApi: 'responses' },
  });
  assert.equal(out.ok, false);
});

test('a refusal never quotes a value of the file', () => {
  const out = parseLocalBackend({ ...valid, env: { ANTHROPIC_AUTH_TOKEN: { secret: 'sk-live-not-a-name' } } });
  assert.equal(out.ok, false);
  assert.doesNotMatch((out as { reason: string }).reason, /sk-live/);
});

test('a dropped file becomes dispatchable, and stops being so when removed', () => {
  clear();
  let changes = 0;
  const off = onBackendsChanged(() => { changes++; });
  drop('acme.json', valid);
  reloadLocalBackends();
  assert.equal(isBackendName('acme'), true);
  assert.ok(backendCatalog().some((backend) => backend.id === 'acme' && backend.custom === true));
  assert.ok(changes > 0, 'the UI must be told');

  const before = changes;
  reloadLocalBackends();
  assert.equal(changes, before, 'an untouched folder announces nothing');

  rmSync(join(DIR, 'acme.json'));
  reloadLocalBackends();
  assert.equal(isBackendName('acme'), false);
  off();
});

test('an edited file is re-registered with its new content', () => {
  clear();
  drop('acme.json', valid);
  reloadLocalBackends();
  drop('acme.json', { ...valid, label: 'Acme v2' });
  reloadLocalBackends();
  assert.equal(activeProfiles().find((p) => p.profile.id === 'acme')?.profile.label, 'Acme v2');
  clear();
});

test('an unknown dialect makes the profile inactive with a reason, not a failed load', () => {
  clear();
  drop('exotic.json', { ...valid, id: 'exotic', dialect: 'not-installed' });
  const listed = reloadLocalBackends();
  assert.equal(listed.find((row) => row.id === 'exotic')?.issue, null, 'the file itself is fine');
  assert.equal(isBackendName('exotic'), false);
  assert.match(inactiveProfiles().find((row) => row.id === 'exotic')?.reason ?? '', /dialect not-installed is not installed/);
  clear();
});

test('a file cannot take the id of a product backend', () => {
  clear();
  const original = activeProfiles().find((p) => p.profile.id === 'claude')?.profile;
  drop('claude.json', { ...valid, id: 'claude' });
  const listed = reloadLocalBackends();
  assert.match(listed.find((row) => row.id === 'claude')?.issue ?? '', /already taken/);
  assert.equal(activeProfiles().find((p) => p.profile.id === 'claude')?.profile, original, 'the product profile is untouched');
  clear();
});

test('broken files are reported one by one and never stop the others', () => {
  clear();
  drop('broken.json', '{ not json');
  drop('mismatch.json', { ...valid, id: 'other' });
  drop('Bad Name.json', valid);
  drop('acme.json', valid);
  const listed = reloadLocalBackends();
  assert.equal(listed.find((row) => row.id === 'broken')?.issue, 'not valid JSON');
  assert.match(listed.find((row) => row.id === 'mismatch')?.issue ?? '', /must match/);
  assert.match(listed.find((row) => row.id === 'Bad Name')?.issue ?? '', /file name/);
  assert.equal(isBackendName('acme'), true);
  clear();
});

test('a credential written in clear is tolerated and flagged — by key name, never by value', () => {
  clear();
  drop('acme.json', { ...valid, env: { ...valid.env, ANTHROPIC_AUTH_TOKEN: 'sk-plain-text-key' } });
  reloadLocalBackends();
  const row = listLocalBackends().find((entry) => entry.id === 'acme');
  assert.equal(isBackendName('acme'), true);
  assert.equal(row?.warnings.length, 1);
  assert.match(row?.warnings[0] ?? '', /ANTHROPIC_AUTH_TOKEN/);
  assert.doesNotMatch(row?.warnings[0] ?? '', /sk-plain/);
  clear();
});

test('a vault reference nobody created leaves the profile inactive, reason shown', () => {
  clear();
  drop('acme.json', { ...valid, env: { ...valid.env, ANTHROPIC_AUTH_TOKEN: { secret: 'ACME_MISSING_KEY' } } });
  reloadLocalBackends();
  assert.equal(isBackendName('acme'), false);
  assert.match(inactiveProfiles().find((row) => row.id === 'acme')?.reason ?? '', /ACME_MISSING_KEY/);
  clear();
});

/* ------------------------------------------------------------------ *
 * Environment names a data file may not set (`env-guard.ts`).
 *
 * These are the names that turn a JSON file into code: what the process
 * runs (`NODE_OPTIONS`), where it looks for it (`PATH`), and where a CLI
 * reads its configuration and its credentials (`CODEX_HOME`, `TIMON_HOME`).
 * ------------------------------------------------------------------ */

for (const name of FORBIDDEN_ENV_NAMES) {
  test(`\`${name}\` in env is refused, and the reason names it`, () => {
    const out = parseLocalBackend({ ...valid, env: { ...valid.env, [name]: 'anything' } });
    assert.equal(out.ok, false);
    assert.match((out as { reason: string }).reason, new RegExp(name));
  });
}

for (const prefix of FORBIDDEN_ENV_PREFIXES) {
  test(`the \`${prefix}\` family is refused as a whole`, () => {
    const name = `${prefix}SOMETHING`;
    const out = parseLocalBackend({ ...valid, env: { ...valid.env, [name]: 'anything' } });
    assert.equal(out.ok, false);
    assert.match((out as { reason: string }).reason, new RegExp(name));
  });
}

test('a vault reference does not launder a forbidden name', () => {
  const out = parseLocalBackend({ ...valid, env: { ...valid.env, NODE_OPTIONS: { secret: 'ACME_KEY' } } });
  assert.equal(out.ok, false);
  assert.match((out as { reason: string }).reason, /NODE_OPTIONS/);
});

test('the refusal does not depend on the case written in the file', () => {
  for (const written of ['node_options', 'Node_Options', 'timon_home', 'Codex_Home']) {
    assert.notEqual(forbiddenEnvReason(written), null, written);
    assert.equal(parseLocalBackend({ ...valid, env: { ...valid.env, [written]: 'x' } }).ok, false, written);
  }
});

test('`providerConfig.envKey` goes through the same list', () => {
  const out = parseLocalBackend({
    ...valid, dialect: 'codex', env: { NODE_PATH: NO_KEY_PLACEHOLDER },
    providerConfig: { id: 'timon-acme', name: 'Acme', baseUrl: 'https://llm.acme.test/v1', envKey: 'NODE_PATH', wireApi: 'responses' },
  });
  assert.equal(out.ok, false);
  assert.match((out as { reason: string }).reason, /NODE_PATH/);
});

test('the net itself lets a real provider name through — the dialect decides the rest', () => {
  for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'BACKEND_ACME_API_KEY']) {
    assert.equal(forbiddenEnvReason(name), null, name);
  }
  assert.equal(parseLocalBackend(valid).ok, true);
});

/* ------------------------------------------------------------------ *
 * The dialect's allowlist (`local-env.ts`) — the MAIN barrier.
 *
 * A blacklist over the environment cannot be closed: `GIT_CONFIG_KEY_0`
 * sets `core.sshCommand` on every git call, and the next door is always
 * one we did not list. So the dialect DECLARES what a data file may set on
 * it, and everything else falls without having to be foreseen. These tests
 * matter more than the ones above: they are what makes the frontier
 * positive rather than an enumeration.
 * ------------------------------------------------------------------ */

const claude = getDialect('claude')!;
const codex = getDialect('codex')!;

test('what each dialect declared is accepted, and only on that dialect', () => {
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) {
    assert.equal(localEnvReason(claude, name), null, name);
    assert.notEqual(localEnvReason(codex, name), null, `${name} is not codex's`);
  }
  for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'BACKEND_ACME_API_KEY']) {
    assert.equal(localEnvReason(codex, name), null, name);
    assert.notEqual(localEnvReason(claude, name), null, `${name} is not claude's`);
  }
  assert.equal(parseLocalBackend(valid).ok, true);
});

test('a name no list ever mentioned is refused, because it was never declared', () => {
  // Enumerated nowhere — not in a blacklist, not in a test, not in a doc.
  for (const name of ['WHATEVER_HOOK', 'ACME_ENDPOINT', 'FOO_BAR_BAZ']) {
    assert.notEqual(localEnvReason(claude, name), null, name);
    const out = parseLocalBackend({ ...valid, env: { ...valid.env, [name]: 'x' } });
    assert.equal(out.ok, false, name);
    assert.match((out as { reason: string }).reason, new RegExp(name));
  }
});

test('the reason says what the dialect DOES accept, not only that this name is refused', () => {
  const reason = localEnvReason(claude, 'WHATEVER_HOOK') ?? '';
  assert.match(reason, /claude/);
  assert.match(reason, /ANTHROPIC_\*/);
});

test('git takes its configuration from the environment — none of it is declared', () => {
  // GIT_CONFIG_COUNT/KEY_n/VALUE_n set `core.sshCommand` on every git call the
  // agent makes: arbitrary execution, from a data file. Not one of these names
  // is in `env-guard.ts`, and not one has to be.
  for (const name of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_GLOBAL', 'GIT_EXEC_PATH', 'GIT_PROXY_COMMAND', 'GIT_TEMPLATE_DIR', 'GIT_EDITOR', 'GIT_PAGER']) {
    assert.notEqual(localEnvReason(claude, name), null, name);
    assert.notEqual(localEnvReason(codex, name), null, name);
    assert.equal(parseLocalBackend({ ...valid, env: { ...valid.env, [name]: 'x' } }).ok, false, name);
  }
});

test('the other inherited-configuration families fall the same way', () => {
  for (const name of ['npm_config_script_shell', 'PAGER', 'EDITOR', 'RUBYOPT', 'JAVA_TOOL_OPTIONS', 'ZDOTDIR', 'BASH_FUNC_x%%', 'PROMPT_COMMAND', 'PS4', 'SHELL', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'HTTPS_PROXY', 'MALLOC_CONF', 'GEM_HOME', 'LESSOPEN']) {
    assert.notEqual(localEnvReason(claude, name), null, name);
    assert.notEqual(localEnvReason(codex, name), null, name);
  }
});

test('the blacklist is still a net: a forbidden name stays forbidden inside a declared family', () => {
  // The case the net exists for — a dialect that widened its declaration by
  // accident. `CODEX_*` is not declared today, so the check is made on a
  // dialect that declares it explicitly.
  const widened = { id: 'widened', localEnv: { names: [], prefixes: ['CODEX_', 'ANTHROPIC_'] } };
  assert.equal(localEnvReason(widened, 'ANTHROPIC_BASE_URL'), null);
  assert.match(localEnvReason(widened, 'CODEX_HOME') ?? '', /CODEX_HOME/);
  // And on the real dialects, where it is not declared in the first place.
  assert.notEqual(localEnvReason(codex, 'CODEX_HOME'), null);
  assert.notEqual(localEnvReason(claude, 'CLAUDE_CONFIG_DIR'), null);
});

test('a dialect that declares nothing accepts nothing', () => {
  assert.match(localEnvReason({ id: 'mute' }, 'ANYTHING_AT_ALL') ?? '', /may only name nothing/);
});

test('`providerConfig.envKey` goes through the dialect too', () => {
  const ok = parseLocalBackend({
    ...valid, dialect: 'codex', env: { BACKEND_ACME_API_KEY: NO_KEY_PLACEHOLDER },
    providerConfig: { id: 'timon-acme', name: 'Acme', baseUrl: 'https://llm.acme.test/v1', envKey: 'BACKEND_ACME_API_KEY', wireApi: 'responses' },
  });
  assert.equal(ok.ok, true);
  const out = parseLocalBackend({
    ...valid, dialect: 'codex', env: { BACKEND_ACME_API_KEY: NO_KEY_PLACEHOLDER },
    providerConfig: { id: 'timon-acme', name: 'Acme', baseUrl: 'https://llm.acme.test/v1', envKey: 'WHATEVER_HOOK', wireApi: 'responses' },
  });
  assert.equal(out.ok, false);
  assert.match((out as { reason: string }).reason, /WHATEVER_HOOK/);
});

test('a file on a dialect installed LATER is checked when it activates, never at a spawn', () => {
  // The parse cannot judge what no dialect declares yet, so the file loads and
  // the profile waits. The day a plugin brings the dialect, the registry runs
  // the same check — an undeclared name keeps the profile inactive.
  clear();
  drop('late.json', { ...valid, id: 'late', dialect: 'later', env: { WHATEVER_HOOK: 'x' } });
  const listed = reloadLocalBackends();
  assert.equal(listed.find((row) => row.id === 'late')?.issue, null, 'the file itself is readable');
  assert.equal(isBackendName('late'), false);

  const off = registerDialect('test-plugin', 'later', { ...claude, id: 'later' });
  assert.equal(isBackendName('late'), false, 'the dialect arrived, the name is still not declared');
  assert.match(inactiveProfiles().find((row) => row.id === 'late')?.reason ?? '', /WHATEVER_HOOK/);
  off();
  clear();
});

test('a file naming a forbidden variable stays out of the registry, with its reason', () => {
  clear();
  drop('evil.json', { ...valid, id: 'evil', env: { ...valid.env, NODE_OPTIONS: '--require /tmp/x.js' } });
  drop('acme.json', valid);
  const listed = reloadLocalBackends();
  assert.match(listed.find((row) => row.id === 'evil')?.issue ?? '', /NODE_OPTIONS/);
  assert.equal(listed.find((row) => row.id === 'evil')?.profile, null);
  assert.equal(isBackendName('evil'), false, 'nothing can be dispatched on it');
  assert.equal(activeProfiles().some((p) => p.profile.id === 'evil'), false);
  assert.equal(isBackendName('acme'), true, 'the file next to it still loads');
  clear();
});

test('a file redirecting a CLI home stays out of the registry too', () => {
  clear();
  drop('sneaky.json', { ...valid, id: 'sneaky', env: { ...valid.env, CODEX_HOME: '/tmp/theirs' } });
  const listed = reloadLocalBackends();
  assert.match(listed.find((row) => row.id === 'sneaky')?.issue ?? '', /CODEX_HOME/);
  assert.equal(isBackendName('sneaky'), false);
  clear();
});

/* ------------------------------------------------------------------ *
 * Two origins, two policies (`EnvOrigin`, `local-env.ts`).
 *
 * A user file gets its dialect's allowlist; a signed provider pack keeps the
 * public pack contract (the provider-data shape of `env-shape.ts`). The
 * boundary of the user folder is never widened by the pack policy existing.
 * ------------------------------------------------------------------ */

test('the same variable is accepted in a pack and refused in a user file — at parse', () => {
  const entry = { ...valid, id: 'acme-cross', env: { ...valid.env, ACME_API_KEY: NO_KEY_PLACEHOLDER } };
  assert.equal(parsePackBackend(entry, []).ok, true, 'pack: ACME_API_KEY has the shape of a provider datum');
  const out = parseLocalBackend(entry);
  assert.equal(out.ok, false, 'user file: claude never declared ACME_*');
  assert.match((out as { reason: string }).reason, /ACME_API_KEY/);
});

test('the same variable is accepted in a pack and refused in a user file — at activation', () => {
  // The registry rechecks by ORIGIN too: a pack entry is not held to the
  // dialect's allowlist, a user file is, whatever it looks like.
  const shape = { dialect: 'claude', label: 'Cross', models: [], defaultModel: null, env: { ACME_API_KEY: NO_KEY_PLACEHOLDER } };
  const offPack = registerPackProfile('cross-pack', { ...shape, id: 'cross-pack' });
  const offFile = registerFileProfile('local-file', { ...shape, id: 'cross-file' });
  try {
    assert.equal(isBackendName('cross-pack'), true);
    assert.equal(isBackendName('cross-file'), false);
    assert.match(inactiveProfiles().find((row) => row.id === 'cross-file')?.reason ?? '', /ACME_API_KEY/);
  } finally {
    offPack();
    offFile();
  }
});

test('the pack policy still refuses what executes code', () => {
  for (const name of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'PATH', 'LD_PRELOAD', 'BASH_FUNC_x%%', 'NODE_OPTIONS', 'TIMON_API_TOKEN', 'npm_config_script_shell']) {
    assert.equal(parsePackBackend({ ...valid, env: { ...valid.env, [name]: 'x' } }, []).ok, false, `pack: ${name}`);
    assert.equal(parseLocalBackend({ ...valid, env: { ...valid.env, [name]: 'x' } }).ok, false, `user file: ${name}`);
  }
});

test('a user file cannot borrow the pack policy nor point at plugin settings', () => {
  // No field of the file selects its origin, and `{ setting }` has no pack to
  // resolve against in the user folder.
  const out = parseLocalBackend({ ...valid, env: { ...valid.env, ANTHROPIC_AUTH_TOKEN: { setting: 'apiKey' } } });
  assert.equal(out.ok, false);
});

test('Azure-shaped hosts date their API: `OPENAI_API_VERSION` is accepted on codex', () => {
  const out = parseLocalBackend({
    ...valid, id: 'azure', dialect: 'codex',
    env: { BACKEND_AZURE_API_KEY: { secret: 'BACKEND_AZURE_API_KEY' }, OPENAI_API_VERSION: '2025-04-01-preview' },
    providerConfig: { id: 'timon-azure', name: 'Azure', baseUrl: 'https://acme.openai.azure.com/openai', envKey: 'BACKEND_AZURE_API_KEY', wireApi: 'responses' },
  });
  assert.equal(out.ok, true, out.ok ? '' : out.reason);
});

/* The public recipes, read from the page testers copy them from. */
const PROVIDER_PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public-docs', 'docs', 'usage', 'add-a-provider.md');

function recipe(id: string): unknown {
  const blocks = [...readFileSync(PROVIDER_PAGE, 'utf8').matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]) as { id?: string });
  const found = blocks.find((block) => block.id === id);
  assert.ok(found, `recipe ${id} is on the page`);
  return found;
}

test('the OpenRouter recipe of the public page parses as a user file, verbatim', () => {
  const out = parseLocalBackend(recipe('openrouter'));
  assert.equal(out.ok, true, out.ok ? '' : out.reason);
});

test('the DeepSeek recipe of the public page parses as a user file, verbatim', () => {
  const out = parseLocalBackend(recipe('deepseek'));
  assert.equal(out.ok, true, out.ok ? '' : out.reason);
});

test('both LiteLLM recipes of the public page parse as user files, verbatim', () => {
  for (const id of ['litellm', 'litellm-responses']) {
    const out = parseLocalBackend(recipe(id));
    assert.equal(out.ok, true, out.ok ? '' : out.reason);
  }
  // The optional variables the page suggests adding are names a file may set.
  assert.equal(localEnvReason(claude, 'ANTHROPIC_DEFAULT_HAIKU_MODEL'), null);
  assert.equal(parseLocalBackend({ ...(recipe('litellm-responses') as object),
    modelsEndpoint: { url: 'http://localhost:4000/v1/models', format: 'openai' } }).ok, true);
});

test('a file written from the OLD OpenRouter recipe is refused with the name to use instead', () => {
  const old = {
    id: 'openrouter', dialect: 'codex', label: 'OpenRouter',
    env: { OPENROUTER_API_KEY: { secret: 'OPENROUTER_API_KEY' } },
    providerConfig: { id: 'timon-openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', wireApi: 'responses' },
    defaultModel: null, models: [],
  };
  const out = parseLocalBackend(old);
  assert.equal(out.ok, false);
  const reason = (out as { reason: string }).reason;
  assert.match(reason, /`OPENROUTER_API_KEY`/);
  assert.match(reason, /BACKEND_OPENROUTER_API_KEY/);
  // And the suggestion is itself accepted.
  assert.equal(localEnvReason(codex, 'BACKEND_OPENROUTER_API_KEY'), null);

  clear();
  drop('openrouter.json', old);
  const listed = reloadLocalBackends();
  assert.match(listed.find((row) => row.id === 'openrouter')?.issue ?? '', /BACKEND_OPENROUTER_API_KEY/);
  clear();
});

test('no rename is suggested where the renamed name would be refused too', () => {
  assert.doesNotMatch(localEnvReason(codex, 'npm_config_script_shell') ?? '', /rename/);
  assert.doesNotMatch(localEnvReason(claude, 'OPENROUTER_API_KEY') ?? '', /rename/);
});
