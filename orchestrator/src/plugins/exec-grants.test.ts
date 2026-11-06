/**
 * Authorizing a provider's binary: the daemon resolves the declared names, the
 * superadmin accepts the RESOLVED path, and that path (never a client-supplied
 * one) feeds `pluginPolicy.exec.allow`.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');
const { assertExecAllowed, PluginPolicyError, resetPluginPolicyState } = await import('./policy.js');
const { providerBinaryRequests, grantProviderBinaries, removeAllowEntries, ExecGrantError } = await import('./exec-grants.js');
const { checkBinaryIdentity, resetBinaryIdentityCache } = await import('../backends/binary-identity.js');

const posix = process.platform !== 'win32';
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'exec-grants-')));
const bindir = join(dir, 'bin');
mkdirSync(bindir);
const agent = join(bindir, 'acme-agent');
if (posix) {
  writeFileSync(agent, '#!/bin/sh\nexit 0\n');
  chmodSync(agent, 0o755);
}
const previousPath = process.env.PATH;
process.env.PATH = `${bindir}${delimiter}${previousPath ?? ''}`;
test.after(() => { process.env.PATH = previousPath; resetConfig(); resetPluginPolicyState(); });

const manifest = (name: string, aliases: string[] = []) => ({
  id: 'acme-provider',
  kind: ['provider' as const],
  provider: { binaries: [{ name, aliases }] },
});

function freshConfig(): string {
  const file = join(dir, `config-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, `${JSON.stringify({ version: 1, settings: { TIMON_FALLBACK_ENABLED: false } }, null, 2)}\n`);
  setConfig(TimonConfigSchema.parse({}));
  resetPluginPolicyState();
  return file;
}

const allowOf = (file: string): string[] => (JSON.parse(readFileSync(file, 'utf8')) as { pluginPolicy?: { exec?: { allow?: string[] } } }).pluginPolicy?.exec?.allow ?? [];

test('a provider binary is reported with its resolved path, and unresolved when absent', { skip: !posix }, () => {
  freshConfig();
  const [found] = providerBinaryRequests(manifest('acme-agent'));
  assert.deepEqual(found, { name: 'acme-agent', found: 'acme-agent', resolved: agent, allowed: false, refused: null });
  const [alias] = providerBinaryRequests(manifest('not-installed-anywhere', ['acme-agent']));
  assert.equal(alias!.found, 'acme-agent');
  assert.equal(alias!.resolved, agent);
  const [missing] = providerBinaryRequests(manifest('not-installed-anywhere'));
  assert.equal(missing!.resolved, null);
  assert.deepEqual(providerBinaryRequests({ kind: ['widget'], provider: undefined }), []);
});

test('accepting the shown path allows the bare name, and launches the pinned path', { skip: !posix }, async () => {
  const file = freshConfig();
  assert.throws(() => assertExecAllowed('acme-provider', 'acme-agent'), PluginPolicyError);
  const granted = await grantProviderBinaries(manifest('acme-agent'), [agent], file);
  assert.deepEqual(granted.granted, [agent]);
  assert.deepEqual(allowOf(file), [agent]);
  // setConfig is only called for the real config file: refresh by hand here.
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { exec: { allow: allowOf(file) } } }));
  assert.equal(assertExecAllowed('acme-provider', 'acme-agent'), agent, 'the policy hands back the path to launch');
  assert.equal(providerBinaryRequests(manifest('acme-agent'))[0]!.allowed, true);
  // The same name resolving elsewhere would NOT be authorized.
  const other = join(dir, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'acme-agent'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(other, 'acme-agent'), 0o755);
  process.env.PATH = `${other}${delimiter}${bindir}${delimiter}${previousPath ?? ''}`;
  try {
    assert.throws(() => assertExecAllowed('acme-provider', 'acme-agent'), PluginPolicyError);
  } finally {
    process.env.PATH = `${bindir}${delimiter}${previousPath ?? ''}`;
  }
});

test('a path the daemon did not resolve is a 409, never granted', { skip: !posix }, async () => {
  const file = freshConfig();
  for (const accepted of [[], ['/usr/bin/ls'], [agent, '/usr/bin/ls']]) {
    await assert.rejects(
      grantProviderBinaries(manifest('acme-agent'), accepted, file),
      (err: unknown) => err instanceof ExecGrantError && err.code === 'mismatch' && err.status === 409,
    );
  }
  assert.deepEqual(allowOf(file), []);
});

test('the absolute denylist wins over an accepted path', { skip: !posix }, async () => {
  const file = freshConfig();
  const sh = providerBinaryRequests(manifest('sh'))[0]!;
  assert.match(sh.refused ?? '', /launcher|whatever command/);
  await assert.rejects(
    grantProviderBinaries(manifest('sh'), sh.resolved ? [sh.resolved] : [], file),
    (err: unknown) => err instanceof ExecGrantError && err.code === 'refused',
  );
  // `claude` is refused by name even when it is not installed.
  assert.equal(providerBinaryRequests(manifest('claude'))[0]!.refused !== null, true);
  assert.deepEqual(allowOf(file), []);
});

test('granting twice does not duplicate, and a rollback removes only what was added', { skip: !posix }, async () => {
  const file = freshConfig();
  writeFileSync(file, `${JSON.stringify({ version: 1, pluginPolicy: { exec: { allow: ['git'] } } }, null, 2)}\n`);
  await grantProviderBinaries(manifest('acme-agent'), [agent], file);
  await grantProviderBinaries(manifest('acme-agent'), [agent], file);
  assert.deepEqual(allowOf(file), ['git', agent]);
  removeAllowEntries([agent], file);
  assert.deepEqual(allowOf(file), ['git']);
});

/**
 * #531 (3-B): what the operator authorizes is the FILE a link leads to, not the link. A link
 * retargeted afterwards names another program: shown as not authorized, and refused until accepted again.
 */
test('a link is authorized by its target: retargeting it needs a new authorization', { skip: !posix }, async () => {
  const file = freshConfig();
  const versions = join(dir, 'versions');
  mkdirSync(join(versions, 'v1'), { recursive: true });
  mkdirSync(join(versions, 'v2'), { recursive: true });
  for (const v of ['v1', 'v2']) {
    writeFileSync(join(versions, v, 'linked-agent'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(versions, v, 'linked-agent'), 0o755);
  }
  const link = join(bindir, 'linked-agent');
  symlinkSync(join(versions, 'v1', 'linked-agent'), link);
  try {
    const [shown] = providerBinaryRequests(manifest('linked-agent'));
    assert.equal(shown!.resolved, join(versions, 'v1', 'linked-agent'), 'the file the link leads to is what is shown');
    await grantProviderBinaries(manifest('linked-agent'), [shown!.resolved!], file);
    assert.deepEqual(allowOf(file), [join(versions, 'v1', 'linked-agent')]);
    setConfig(TimonConfigSchema.parse({ pluginPolicy: { exec: { allow: allowOf(file) } } }));
    assert.equal(assertExecAllowed('acme-provider', 'linked-agent'), link, 'the link still launches, through the file it was authorized for');
    assert.equal(assertExecAllowed('acme-provider', link), link);
    rmSync(link);
    symlinkSync(join(versions, 'v2', 'linked-agent'), link);
    assert.equal(providerBinaryRequests(manifest('linked-agent'))[0]!.allowed, false, 'another file: not authorized any more');
    assert.throws(() => assertExecAllowed('acme-provider', 'linked-agent'), PluginPolicyError);
  } finally {
    rmSync(link, { force: true });
  }
});

/**
 * TODO #588: the identity the manifest mirrors is checked on the click, after the consent, and a program
 * that does not have it leaves the allowlist untouched. Each stub counts its runs in a witness file.
 */
const IDENTITY = { pattern: '^acme \\d+', expected: "Acme's CLI" };
const withIdentity = (name: string, aliases: string[] = []) => ({
  id: 'acme-provider',
  kind: ['provider' as const],
  provider: { binaries: [{ name, aliases, identity: IDENTITY }] },
});

function program(name: string, says: string, folder = bindir): { path: string; runs: () => number } {
  const path = join(folder, name);
  const witness = `${path}.runs`;
  writeFileSync(witness, '');
  writeFileSync(path, `#!/bin/sh\necho x >> "${witness}"\necho "${says}"\n`);
  chmodSync(path, 0o755);
  return { path, runs: () => readFileSync(witness, 'utf8').split('\n').filter(Boolean).length };
}

test('the preview runs nothing; the click runs the program, and the right one is granted', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const file = freshConfig();
  const right = program('acme-right', 'acme 1.2.3');
  const [shown] = providerBinaryRequests(withIdentity('acme-right'));
  assert.deepEqual(shown, { name: 'acme-right', found: 'acme-right', resolved: right.path, allowed: false, refused: null }, 'the identity is not sent to the screen');
  assert.equal(right.runs(), 0, 'nothing is started before the person accepts');
  const granted = await grantProviderBinaries(withIdentity('acme-right'), [right.path], file);
  assert.deepEqual(granted, { granted: [right.path], added: [right.path] });
  assert.deepEqual(allowOf(file), [right.path]);
  assert.equal(right.runs(), 1);
});

test('REFUSAL: another program under the same name is a 409, and the file is not touched', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const file = freshConfig();
  writeFileSync(file, `${JSON.stringify({ version: 1, pluginPolicy: { exec: { allow: ['git'] } } }, null, 2)}\n`);
  const before = readFileSync(file, 'utf8');
  const stranger = program('acme-stranger', 'grok-cli 0.9.1');
  await assert.rejects(
    grantProviderBinaries(withIdentity('acme-stranger'), [stranger.path], file),
    (err: unknown) => err instanceof ExecGrantError && err.code === 'binary-identity' && err.status === 409
      && err.message.includes(stranger.path) && err.message.includes('grok-cli 0.9.1') && err.message.includes("Acme's CLI"),
  );
  assert.equal(readFileSync(file, 'utf8'), before, 'not a byte written');
});

test('REFUSAL: a pattern past its time limit names the manifest field, the one read at the click', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const file = freshConfig();
  const slow = program('acme-slow-pattern', `${'a'.repeat(40)}!`);
  const declared = {
    id: 'acme-provider',
    kind: ['provider' as const],
    provider: { binaries: [{ name: 'acme-slow-pattern', aliases: [], identity: { pattern: '^(a+)+$' } }] },
  };
  await assert.rejects(
    grantProviderBinaries(declared, [slow.path], file),
    (err: unknown) => err instanceof ExecGrantError && err.code === 'binary-identity' && err.status === 409
      && err.message.includes('`provider.binaries[].identity.pattern`') && !err.message.includes('declares.binary'),
  );
  assert.deepEqual(allowOf(file), []);
});

test('REFUSAL: an alias that resolves to another program authorizes nothing', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const file = freshConfig();
  const stranger = program('agent', 'grok-cli 0.9.1');
  const declared = withIdentity('acme-not-installed', ['agent']);
  assert.equal(providerBinaryRequests(declared)[0]!.resolved, stranger.path, 'the alias is what the operator is shown');
  await assert.rejects(
    grantProviderBinaries(declared, [stranger.path], file),
    (err: unknown) => err instanceof ExecGrantError && err.code === 'binary-identity',
  );
  assert.deepEqual(allowOf(file), []);
  rmSync(stranger.path);
});

test('REFUSAL: one program out of two failing writes neither', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const file = freshConfig();
  const right = program('acme-one', 'acme 1.0');
  const stranger = program('acme-two', 'someone else');
  const declared = {
    id: 'acme-provider',
    kind: ['provider' as const],
    provider: { binaries: [{ name: 'acme-one', aliases: [], identity: IDENTITY }, { name: 'acme-two', aliases: [], identity: IDENTITY }] },
  };
  await assert.rejects(
    grantProviderBinaries(declared, [right.path, stranger.path], file),
    (err: unknown) => err instanceof ExecGrantError && err.code === 'binary-identity',
  );
  assert.deepEqual(allowOf(file), []);
});

test('a refusal that needs no program starts none: a mismatch or the denylist come first', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const file = freshConfig();
  const right = program('acme-unasked', 'acme 1.0');
  await assert.rejects(
    grantProviderBinaries(withIdentity('acme-unasked'), ['/usr/bin/ls'], file),
    (err: unknown) => err instanceof ExecGrantError && err.code === 'mismatch',
  );
  assert.equal(right.runs(), 0);
  const denied = program('sh', 'acme 1.0');
  await assert.rejects(
    grantProviderBinaries(withIdentity('sh'), [denied.path], file),
    (err: unknown) => err instanceof ExecGrantError && err.code === 'refused',
  );
  assert.equal(denied.runs(), 0);
  rmSync(denied.path);
  assert.deepEqual(allowOf(file), []);
});

test('the check runs through the link, as a launch does, and hands it its answer', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const file = freshConfig();
  const store = join(dir, 'identity-store');
  mkdirSync(store);
  const target = program('real-file', 'irrelevant', store);
  // A launcher that answers by the name it was started under: only the link says the right thing.
  writeFileSync(target.path, `#!/bin/sh\ncase "$0" in *acme-linked) echo "acme 2.0";; *) echo "unknown";; esac\n`);
  const link = join(bindir, 'acme-linked');
  symlinkSync(target.path, link);
  try {
    const granted = await grantProviderBinaries(withIdentity('acme-linked'), [target.path], file);
    assert.deepEqual(granted.granted, [target.path], 'what is written is the file, as the operator saw it');
    assert.deepEqual(await checkBinaryIdentity(link, IDENTITY), { ok: true });
  } finally {
    rmSync(link, { force: true });
  }
});

test('REFUSAL: a name that moves while the program answers is a 409, nothing written', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const file = freshConfig();
  const store = join(dir, 'moving-store');
  mkdirSync(store);
  const link = join(bindir, 'acme-moving');
  const other = program('other-file', 'acme 9.9', store);
  const first = join(store, 'first-file');
  // It passes the check, and points the link elsewhere on its way out.
  writeFileSync(first, `#!/bin/sh\nrm -f "${link}"\nln -s "${other.path}" "${link}"\necho "acme 1.0"\n`);
  chmodSync(first, 0o755);
  symlinkSync(first, link);
  try {
    await assert.rejects(
      grantProviderBinaries(withIdentity('acme-moving'), [first], file),
      (err: unknown) => err instanceof ExecGrantError && err.code === 'mismatch' && err.status === 409,
    );
    assert.deepEqual(allowOf(file), []);
  } finally {
    rmSync(link, { force: true });
  }
});
