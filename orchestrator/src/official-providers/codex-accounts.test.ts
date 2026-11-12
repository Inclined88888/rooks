/**
 * TODO #52 — a codex subscription account runs on its own sign-in, and on nothing that could stand
 * in for it. Through the real registry: the account is a row of the database, its folder the one the
 * daemon opened to the plugin's `scratch.link`, its profile the `codex@<id>` instance.
 */
import '../test-home.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, lstatSync, rmSync, copyFileSync, linkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getHost } from '../host/index.js';
import { ROOKS_HOME } from '../paths.js';
import { config } from '../config/load.js';
import type { ProfileRuntime } from '../backends/types.js';

const { mountOfficialProviders, buildDialectUnderSeal } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { createBackendAccount, accountConfigDir } = await import('../backends/accounts.js');
const { getDialect } = await import('../backends/registry.js');
const { linksElsewhere } = await import('../../official-providers/provider-codex/lib/codex.js');
const { isUsageNotSignedInError } = await import('../backends/usage-error.js');

/** A real account of codex: a row, a folder, and the profile a launch on it carries. */
function account(): { profile: ProfileRuntime; dir: string } {
  const row = createBackendAccount({ backend: 'codex', name: `Pro-${randomUUID().slice(0, 6)}`, ownerUserId: null });
  const dir = accountConfigDir(row.id);
  return { dir, profile: { id: `codex@${row.id}`, cmd: 'codex', env: {}, account: { id: row.id, name: row.name, configDir: dir } } };
}

const opts = (missionId = randomUUID()) => ({ agentName: 'acct', missionId,
  cfg: { cwd: ROOKS_HOME, browser_profile_id: null }, systemPrompt: 'Test', message: 'Test', resumeSession: null });
const build = (profile: ProfileRuntime, missionId?: string) => buildDialectUnderSeal(profile.id, 'codex', profile, opts(missionId));

function isolate(t: TestContext) {
  const before = { ...process.env };
  const inherit = config().secrets.inheritEnv;
  t.after(() => { config().secrets.inheritEnv = inherit; process.env = before; });
  process.env.CODEX_AUTH_DIR = join(ROOKS_HOME, randomUUID());
  t.mock.method(getHost(), 'execAsync', () => { throw new Error('unexpected CLI check'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network'); });
}

test('codex measures an account on its own directory, never the host\'s sign-in (TODO #330)', async (t) => {
  isolate(t);
  // A host sign-in is there; the account directory is empty.
  mkdirSync(process.env.CODEX_AUTH_DIR!, { recursive: true });
  writeFileSync(join(process.env.CODEX_AUTH_DIR!, 'auth.json'), JSON.stringify({ tokens: { access_token: 'host', account_id: 'host' } }));
  const dialect = getDialect('codex') as import('../backends/types.js').Dialect;
  await assert.rejects(dialect.accountUsage!(account().profile), (error) => isUsageNotSignedInError(error));
});

test('an account not signed in yet refuses the launch, even with a host login', async (t) => {
  isolate(t);
  mkdirSync(process.env.CODEX_AUTH_DIR!, { recursive: true });
  writeFileSync(join(process.env.CODEX_AUTH_DIR!, 'auth.json'), '{"host":true}');
  await assert.rejects(build(account().profile), /codex account "Pro-[0-9a-f]+" is not signed in/);
});

test('the mission links the account auth.json and ignores an inherited key', async (t) => {
  isolate(t);
  config().secrets.inheritEnv = true;
  process.env.CODEX_API_KEY = 'host-key';
  mkdirSync(process.env.CODEX_AUTH_DIR!, { recursive: true });
  writeFileSync(join(process.env.CODEX_AUTH_DIR!, 'auth.json'), '{"host":true}');
  const acct = account();
  writeFileSync(join(acct.dir, 'auth.json'), '{"account":true}');
  const spec = await build(acct.profile);
  assert.equal(spec.env?.CODEX_API_KEY, '');
  assert.equal(readFileSync(join(spec.env!.CODEX_HOME!, 'auth.json'), 'utf8'), '{"account":true}');
});

test('a link left on another sign-in is replaced on the next turn', async (t) => {
  isolate(t);
  const missionId = randomUUID();
  mkdirSync(process.env.CODEX_AUTH_DIR!, { recursive: true });
  writeFileSync(join(process.env.CODEX_AUTH_DIR!, 'auth.json'), '{"host":true}');
  const host = await build({ id: 'codex', cmd: 'codex', env: {} }, missionId);
  const linked = join(host.env!.CODEX_HOME!, 'auth.json');
  assert.equal(readFileSync(linked, 'utf8'), '{"host":true}');

  const acct = account();
  writeFileSync(join(acct.dir, 'auth.json'), '{"account":true}');
  await build(acct.profile, missionId);
  assert.equal(readFileSync(linked, 'utf8'), '{"account":true}', 'the mission now runs on the account');
  if (lstatSync(linked).isSymbolicLink()) assert.equal(realpathSync(linked), realpathSync(join(acct.dir, 'auth.json')));
});

test('an operator who moved the host\'s sign-in (CODEX_AUTH_DIR) keeps it exposed to missions', async (t) => {
  isolate(t);
  const moved = join(ROOKS_HOME, `moved-${randomUUID()}`);
  mkdirSync(moved, { recursive: true });
  writeFileSync(join(moved, 'auth.json'), '{"moved":true}');
  process.env.CODEX_AUTH_DIR = moved;
  const spec = await build({ id: 'codex', cmd: 'codex', env: {} });
  assert.equal(readFileSync(join(spec.env!.CODEX_HOME!, 'auth.json'), 'utf8'), '{"moved":true}');
});

test('linksElsewhere: only a symlink leading somewhere else', { skip: process.platform === 'win32' }, () => {
  const dir = join(ROOKS_HOME, randomUUID());
  mkdirSync(dir);
  writeFileSync(join(dir, 'a.json'), 'a');
  writeFileSync(join(dir, 'b.json'), 'b');
  symlinkSync(join(dir, 'a.json'), join(dir, 'link.json'));
  assert.equal(linksElsewhere(join(dir, 'link.json'), join(dir, 'a.json')), false);
  assert.equal(linksElsewhere(join(dir, 'link.json'), join(dir, 'b.json')), true);
  assert.equal(linksElsewhere(join(dir, 'a.json'), join(dir, 'b.json')), false, 'a plain file is left alone');
  assert.equal(linksElsewhere(join(dir, 'missing.json'), join(dir, 'b.json')), false);
});


for (const method of ['copy', 'hardlink'] as const) {
  test(`switching accounts replaces credentials exposed through a ${method}`, async (t) => {
    isolate(t);
    const missionId = randomUUID();
    const first = account();
    const second = account();
    const firstAuth = join(first.dir, 'auth.json');
    writeFileSync(firstAuth, '{"first":true}');
    writeFileSync(join(second.dir, 'auth.json'), '{"second":true}');
    const run = await build(first.profile, missionId);
    const exposed = join(run.env!.CODEX_HOME!, 'auth.json');
    rmSync(exposed);
    if (method === 'copy') copyFileSync(firstAuth, exposed);
    else linkSync(firstAuth, exposed);

    await build(second.profile, missionId);
    assert.equal(readFileSync(exposed, 'utf8'), '{"second":true}');
    assert.equal(readFileSync(firstAuth, 'utf8'), '{"first":true}', 'the old account is untouched');
  });
}

test('a copied credential refreshed by the CLI survives another turn on the same account', async (t) => {
  isolate(t);
  const missionId = randomUUID();
  const acct = account();
  writeFileSync(join(acct.dir, 'auth.json'), '{"initial":true}');
  const run = await build(acct.profile, missionId);
  const exposed = join(run.env!.CODEX_HOME!, 'auth.json');
  rmSync(exposed);
  writeFileSync(exposed, '{"refreshed":true}');
  await build(acct.profile, missionId);
  assert.equal(readFileSync(exposed, 'utf8'), '{"refreshed":true}');
});
