/**
 * secu-5 — what a plugin may do with the capabilities it declared.
 *
 * The audit's finding #5 is not about undeclared permissions: it is about the
 * three declared ones that reach the machine's AI subscriptions. These tests
 * hold the deny-by-default line on each of them, and the escape hatch the
 * operator has (`pluginPolicy` in `timon.config.json`).
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { TimonConfigSchema } = await import('../config/schema.js');
const { config, setConfig, resetConfig } = await import('../config/load.js');
const {
  assertExecAllowed, assertFetchAllowed, assertSpawnAllowed, assertSpawnApproved, hostCovers, narrowLivePluginGrants,
  resetPluginPolicyState, setPluginSpawnStanding, PluginPolicyError,
} = await import('./policy.js');

type PolicyInput = {
  spawn?: { max?: number; windowMs?: number; approved?: string[]; denied?: string[]; autoApproveSigned?: boolean };
  exec?: { allow?: string[] };
  http?: { allow?: string[]; byPlugin?: Record<string, string[]> };
};

/** Installs a `pluginPolicy` through the REAL schema: a test must not be able
 *  to configure something `timon.config.json` would refuse. */
function withPolicy(pluginPolicy: PolicyInput): void {
  setConfig(TimonConfigSchema.parse({ pluginPolicy }));
  resetPluginPolicyState();
}

test.after(() => { resetConfig(); resetPluginPolicyState(); });

test('host:exec refuses everything when the allowlist is empty', () => {
  withPolicy({});
  assert.throws(() => assertExecAllowed('p', 'ls'), PluginPolicyError);
});

test('host:exec allows an allowlisted binary, by basename or absolute path', () => {
  withPolicy({ exec: { allow: ['ls', '/opt/tools/report'] } });
  assertExecAllowed('p', 'ls');
  assertExecAllowed('p', '/usr/bin/ls');
  assertExecAllowed('p', '/opt/tools/report');
  assert.throws(() => assertExecAllowed('p', 'curl'), PluginPolicyError);
});

/** The subscriptions and the daemon itself: allowlisting them is refused, not
 *  honoured — that path is the whole point of the finding. */
test('host:exec never runs claude, codex, git-credential or the timon CLI', () => {
  // public-name-ok: the archive guard refuses it by name
  withPolicy({ exec: { allow: ['claude', 'codex', 'git-credential-store', 'timon', 'pkos'] } });
  for (const bin of ['claude', 'codex', 'git-credential-store', 'timon', 'pkos']) {
    assert.throws(() => assertExecAllowed('p', bin), PluginPolicyError, bin);
  }
  // Same refusal through a path or a Windows extension.
  assert.throws(() => assertExecAllowed('p', '/home/user/.local/bin/claude'), PluginPolicyError);
  assert.throws(() => assertExecAllowed('p', 'CODEX.EXE'), PluginPolicyError);
});

/**
 * The bypass the denylist above invites: an allowlist holding `sh` (or `node`,
 * `env`, `xargs`…) reaches `claude` through `sh -c "claude …"`, and this module
 * only ever sees `sh`. Allowlisting a generic launcher is refused, not honoured.
 */
test('host:exec never runs a shell, an interpreter or a generic launcher', () => {
  const launchers = ['sh', 'bash', 'zsh', 'node', 'python3', 'perl', 'env', 'xargs', 'sudo', 'npx', 'docker'];
  withPolicy({ exec: { allow: launchers } });
  for (const bin of launchers) {
    assert.throws(() => assertExecAllowed('p', bin), PluginPolicyError, bin);
  }
  // Same refusal through a path or a Windows extension.
  assert.throws(() => assertExecAllowed('p', '/usr/bin/sh'), PluginPolicyError);
  assert.throws(() => assertExecAllowed('p', 'C:\\Windows\\System32\\cmd.exe'), PluginPolicyError);
  // The refusal names the reason, so an operator does not read it as "not allowlisted".
  assert.throws(() => assertExecAllowed('p', 'sh'), /generic launcher/);
});

/** The limit, held by a test so nobody reads the denylist as a sandbox: the
 *  check is name-based, and an ordinary binary stays allowlistable. */
test('host:exec still allows a plain binary whose name is not a launcher', () => {
  withPolicy({ exec: { allow: ['rsync', 'git', '/opt/tools/report'] } });
  assertExecAllowed('p', 'rsync');
  assertExecAllowed('p', 'git');
  assertExecAllowed('p', '/opt/tools/report');
});

test('http:outbound refuses every host when the allowlist is empty', () => {
  withPolicy({});
  assert.throws(() => assertFetchAllowed('p', 'https://example.com/x'), PluginPolicyError);
});

test('http:outbound matches exact hosts, and subdomains only through *.', () => {
  withPolicy({ http: { allow: ['example.com', '*.corp.net'] } });
  assertFetchAllowed('p', 'https://example.com/path');
  assertFetchAllowed('p', new URL('https://EXAMPLE.com/path'));
  assertFetchAllowed('p', new Request('https://api.corp.net/v1'));
  assert.throws(() => assertFetchAllowed('p', 'https://corp.net/'), PluginPolicyError);
  assert.throws(() => assertFetchAllowed('p', 'https://evil.example.com.attacker.tld/'), PluginPolicyError);
  assert.throws(() => assertFetchAllowed('p', 'file:///etc/passwd'), PluginPolicyError);
});

/**
 * TODO #599: a host consented to for one plugin is opened to THAT plugin. The
 * shared `allow` would open it to every `http:outbound` plugin, which is what
 * "nominative" consent must not do.
 */
test('http:outbound: a byPlugin host is reachable by its plugin, and by no other', () => {
  withPolicy({ http: { byPlugin: { a: ['api.a.example', '*.cdn.a.example'], b: ['api.b.example'] } } });
  assertFetchAllowed('a', 'https://api.a.example/v1');
  assertFetchAllowed('a', 'https://img.cdn.a.example/x.png');
  assert.throws(() => assertFetchAllowed('b', 'https://api.a.example/v1'), PluginPolicyError);
  assert.throws(() => assertFetchAllowed('b', 'https://img.cdn.a.example/x.png'), PluginPolicyError);
  assert.throws(() => assertFetchAllowed('a', 'https://api.b.example/'), PluginPolicyError);
  // A plugin with no entry reaches nothing: it does not borrow a neighbour's.
  assert.throws(() => assertFetchAllowed('c', 'https://api.a.example/v1'), PluginPolicyError);
  // Same wildcard rule as `allow`: subdomains only, never the bare suffix.
  assert.throws(() => assertFetchAllowed('a', 'https://cdn.a.example/'), PluginPolicyError);
  // The scheme check still comes first.
  assert.throws(() => assertFetchAllowed('a', 'ftp://api.a.example/'), /scheme/);
});

test('http:outbound: the shared allowlist is still honoured next to byPlugin', () => {
  withPolicy({ http: { allow: ['shared.example'], byPlugin: { a: ['api.a.example'] } } });
  assertFetchAllowed('a', 'https://shared.example/');
  assertFetchAllowed('b', 'https://shared.example/');
  assertFetchAllowed('a', 'https://api.a.example/');
  assert.throws(() => assertFetchAllowed('b', 'https://api.a.example/'), /neither in pluginPolicy\.http\.allow nor opened to this plugin/);
});

/** No caller, or a caller named after a prototype member, never finds an entry. */
test('http:outbound: an anonymous or prototype-named caller gets no byPlugin entry', () => {
  withPolicy({ http: { byPlugin: { a: ['api.a.example'] } } });
  assert.throws(() => assertFetchAllowed('', 'https://api.a.example/'), PluginPolicyError);
  for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.throws(() => assertFetchAllowed(id, 'https://api.a.example/'), PluginPolicyError, id);
  }
  // The schema refuses an empty id outright: nobody can write an entry for "no one".
  assert.throws(() => TimonConfigSchema.parse({ pluginPolicy: { http: { byPlugin: { '': ['api.a.example'] } } } }));
});

test('http:outbound: with nothing allowed anywhere, the refusal says so', () => {
  withPolicy({ http: { byPlugin: { other: ['api.a.example'] } } });
  assert.throws(() => assertFetchAllowed('p', 'https://api.a.example/'), /no host is reachable by this plugin/);
});

test('missions:spawn is refused until the plugin is approved', () => {
  withPolicy({ spawn: { approved: [] } });
  assert.throws(() => assertSpawnAllowed('p'), PluginPolicyError);
  withPolicy({ spawn: { approved: ['p'] } });
  assertSpawnAllowed('p');
});

test('missions:spawn is capped by a sliding window', () => {
  withPolicy({ spawn: { approved: ['p'], max: 2, windowMs: 1000 } });
  const t0 = 1_000_000;
  assertSpawnAllowed('p', t0);
  assertSpawnAllowed('p', t0 + 10);
  assert.throws(() => assertSpawnAllowed('p', t0 + 20), PluginPolicyError);
  // The window slides: past the horizon, the plugin spawns again.
  assertSpawnAllowed('p', t0 + 1100);
  // And one plugin's quota is not another's.
  withPolicy({ spawn: { approved: ['p', 'q'], max: 1, windowMs: 1000 } });
  assertSpawnAllowed('p', t0);
  assertSpawnAllowed('q', t0);
  assert.throws(() => assertSpawnAllowed('p', t0), PluginPolicyError);
});

test('max: 0 refuses an approved plugin outright', () => {
  withPolicy({ spawn: { approved: ['p'], max: 0 } });
  assert.throws(() => assertSpawnAllowed('p'), PluginPolicyError);
});

/* The distributor's signature stands for the consent (decision of 2026-11-02). */

test('missions:spawn: a signed plugin declaring it is approved without an entry', () => {
  withPolicy({});
  setPluginSpawnStanding('p', { trust: 'signed', declaresSpawn: true });
  assertSpawnAllowed('p');
  assertSpawnApproved('p', 'ctx.routines.create');
});

test('missions:spawn: a built-in plugin declaring it is approved without an entry', () => {
  withPolicy({});
  setPluginSpawnStanding('p', { trust: 'builtin', declaresSpawn: true });
  assertSpawnAllowed('p');
});

test('missions:spawn: an unsigned plugin is still refused without an entry, and told why', () => {
  withPolicy({});
  setPluginSpawnStanding('p', { trust: 'unsigned', declaresSpawn: true });
  assert.throws(() => assertSpawnAllowed('p'), /unsigned plugin, not in `pluginPolicy\.spawn\.approved`/);
  withPolicy({ spawn: { approved: ['p'] } });
  setPluginSpawnStanding('p', { trust: 'unsigned', declaresSpawn: true });
  assertSpawnAllowed('p');
});

test('missions:spawn: a signed plugin that does not declare it, or is no longer mounted, needs an entry', () => {
  withPolicy({});
  setPluginSpawnStanding('p', { trust: 'signed', declaresSpawn: false });
  assert.throws(() => assertSpawnAllowed('p'), PluginPolicyError);
  setPluginSpawnStanding('q', { trust: 'signed', declaresSpawn: true });
  setPluginSpawnStanding('q', null);
  assert.throws(() => assertSpawnAllowed('q'), (err: Error) => err instanceof PluginPolicyError && !/unsigned/.test(err.message));
});

test('missions:spawn: denied overrides the signature and the approved list', () => {
  withPolicy({ spawn: { approved: ['p'], denied: ['p'] } });
  setPluginSpawnStanding('p', { trust: 'signed', declaresSpawn: true });
  assert.throws(() => assertSpawnAllowed('p'), /pluginPolicy\.spawn\.denied/);
  assert.throws(() => assertSpawnApproved('p'), PluginPolicyError);
  withPolicy({ spawn: { denied: ['p'] } });
  setPluginSpawnStanding('p', { trust: 'builtin', declaresSpawn: true });
  assert.throws(() => assertSpawnAllowed('p'), PluginPolicyError);
});

test('missions:spawn: autoApproveSigned: false puts a signed plugin back behind approved', () => {
  withPolicy({ spawn: { autoApproveSigned: false } });
  setPluginSpawnStanding('p', { trust: 'signed', declaresSpawn: true });
  assert.throws(() => assertSpawnAllowed('p'), (err: Error) => err instanceof PluginPolicyError && !/unsigned/.test(err.message));
  withPolicy({ spawn: { autoApproveSigned: false, approved: ['p'] } });
  setPluginSpawnStanding('p', { trust: 'signed', declaresSpawn: true });
  assertSpawnAllowed('p');
});

test('missions:spawn: the quota holds for a signed plugin too', () => {
  withPolicy({ spawn: { max: 1, windowMs: 1000 } });
  setPluginSpawnStanding('p', { trust: 'signed', declaresSpawn: true });
  const t0 = 1_000_000;
  assertSpawnAllowed('p', t0);
  assert.throws(() => assertSpawnAllowed('p', t0 + 10), /quota reached/);
  withPolicy({ spawn: { max: 0 } });
  setPluginSpawnStanding('p', { trust: 'builtin', declaresSpawn: true });
  assert.throws(() => assertSpawnAllowed('p'), /quota reached/);
});

test('hostCovers: a declared wildcard is covered only by a wildcard at its level or above', () => {
  assert.equal(hostCovers('api.acme.com', 'api.acme.com'), true);
  assert.equal(hostCovers('API.acme.com ', 'api.acme.com'), true);
  assert.equal(hostCovers('*.acme.com', 'api.acme.com'), true);
  assert.equal(hostCovers('*.acme.com', '*.acme.com'), true);
  assert.equal(hostCovers('*.acme.com', '*.cdn.acme.com'), true);
  assert.equal(hostCovers('api.acme.com', '*.acme.com'), false, 'one host does not open every subdomain');
  assert.equal(hostCovers('*.cdn.acme.com', '*.acme.com'), false, 'a narrower wildcard does not cover a wider one');
  assert.equal(hostCovers('*.acme.com', 'acme.com'), false);
  assert.equal(hostCovers('*.notacme.com', '*.acme.com'), false);
  assert.equal(hostCovers('', 'acme.com'), false);
});

/* ── narrowLivePluginGrants (TODO #663) ───────────────────────────────────── */

test('the live grants follow what the operator\'s file withdrew, and only that', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-narrow-'));
  const file = join(dir, 'timon.config.json');
  const previous = config();
  const live = {
    spawn: { approved: ['gone', 'stays'], max: 7 },
    kanban: { projects: { gone: ['alpha'], stays: ['beta', 'cut'], constructor: ['gamma'] } },
    http: { allow: ['shared.example'], byPlugin: { gone: ['api.gone.example'], stays: ['api.stays.example'] } },
    exec: { allow: ['rsync'] },
  };
  const liveOf = () => config().pluginPolicy;
  try {
    setConfig(TimonConfigSchema.parse({ pluginPolicy: live }));
    writeFileSync(file, JSON.stringify({
      pluginPolicy: {
        spawn: { approved: ['stays', 'added-by-hand'], max: 1 },
        kanban: { projects: { stays: ['beta'], other: ['added'] } },
        http: { byPlugin: { stays: ['api.stays.example', 'added.example'] } },
      },
    }));
    narrowLivePluginGrants(file);
    assert.deepEqual(liveOf().spawn.approved, ['stays']);
    assert.deepEqual(liveOf().kanban.projects, { stays: ['beta'] }, 'an id like `constructor` is no inherited grant');
    assert.deepEqual(liveOf().http.byPlugin, { stays: ['api.stays.example'] }, 'a grant added to the file still waits for a restart');
    assert.equal(liveOf().spawn.max, 7, 'only the grants by id follow the file');
    assert.deepEqual(liveOf().http.allow, ['shared.example']);
    assert.deepEqual(liveOf().exec.allow, ['rsync']);

    // Nothing withdrawn: the config object itself is not replaced.
    const held = config();
    writeFileSync(file, JSON.stringify({ pluginPolicy: live }));
    narrowLivePluginGrants(file);
    assert.equal(config(), held);
  } finally {
    setConfig(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the live policy takes in a refusal written to the file, never a loosening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-narrow-'));
  const file = join(dir, 'timon.config.json');
  const previous = config();
  try {
    setConfig(TimonConfigSchema.parse({ pluginPolicy: { spawn: { denied: ['kept'] } } }));
    writeFileSync(file, JSON.stringify({ pluginPolicy: { spawn: { denied: ['acme'], autoApproveSigned: false } } }));
    narrowLivePluginGrants(file);
    assert.deepEqual(config().pluginPolicy.spawn.denied, ['kept', 'acme'], 'a denial lifted on disk waits for a restart');
    assert.equal(config().pluginPolicy.spawn.autoApproveSigned, false);
    writeFileSync(file, JSON.stringify({ pluginPolicy: { spawn: { autoApproveSigned: true } } }));
    narrowLivePluginGrants(file);
    assert.equal(config().pluginPolicy.spawn.autoApproveSigned, false, 'turning it back on waits for a restart');
    assert.deepEqual(config().pluginPolicy.spawn.denied, ['kept', 'acme']);
  } finally {
    setConfig(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that says nothing readable withdraws nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-narrow-'));
  const file = join(dir, 'timon.config.json');
  const previous = config();
  try {
    setConfig(TimonConfigSchema.parse({ pluginPolicy: { spawn: { approved: ['acme'] } } }));
    narrowLivePluginGrants(file);
    assert.deepEqual(config().pluginPolicy.spawn.approved, ['acme'], 'no file');
    writeFileSync(file, '{ half a file');
    narrowLivePluginGrants(file);
    assert.deepEqual(config().pluginPolicy.spawn.approved, ['acme'], 'not JSON');
    writeFileSync(file, JSON.stringify({ pluginPolicy: { spawn: { approved: 'acme' } } }));
    narrowLivePluginGrants(file);
    assert.deepEqual(config().pluginPolicy.spawn.approved, ['acme'], 'refused by the schema');
  } finally {
    setConfig(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
