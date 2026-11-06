/**
 * The broker runtime (SECRETS-VAULT.md §6.2, §8; invariants §12.1, §12.3, §12.7,
 * §12.8). No network: `fetchImpl` is injected, so what is exercised is the
 * decision — who may call, where, and what comes back.
 */
// Isolates TIMON_HOME BEFORE any module touching Timon state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbApi } from '../db.js';
import { brokerGitCredential, brokerHttpCall, BrokerDeniedError, MAX_BODY } from './broker.js';
import { resolveBrokerSecret, resolveSecretsFor } from './resolve.js';

const VALUE = 'ghp_a_long_enough_token_value';

const httpSpec = (hosts: string[]) => JSON.stringify({
  type: 'http',
  hosts,
  inject: { kind: 'header', name: 'Authorization', template: 'Bearer {{value}}' },
});

let seq = 0;

/** A brokered secret plus its grants; the value is handed back by `openValue`,
 *  so no master key and no real sealing are needed here. */
function brokered(opts: { hosts?: string[]; grants?: [string, string | null][]; spec?: string } = {}) {
  const name = `BROKER_${(seq += 1)}`;
  const secret = dbApi.createSecret({
    name,
    value_enc: `enc:1:iv:tag:${name}`,
    mode: 'broker',
    broker_spec: opts.spec ?? httpSpec(opts.hosts ?? ['api.github.com']),
  });
  for (const [kind, ref] of opts.grants ?? [['global', null]]) {
    dbApi.addSecretGrant(secret.id, kind as 'global' | 'project' | 'agent', ref);
  }
  return secret;
}

const deps = (fetchImpl?: typeof fetch) => ({
  openValue: () => VALUE,
  fetchImpl: fetchImpl ?? (async () => new Response('{"ok":true}', { status: 200 })),
});

const caller = { missionId: 'm-1', agent: 'timon.coder', project: 'timon' };

test('an allowlisted call goes through, the token rides in the header, the agent gets none of it', async () => {
  const secret = brokered();
  let seen: { url: string; auth: string | null } | null = null;
  const result = await brokerHttpCall(
    { identity: secret.name, path: '/user' },
    caller,
    deps(async (url, init) => {
      seen = { url: String(url), auth: new Headers(init?.headers).get('authorization') };
      // A server echoing the credential back is exactly the accident §6.3 warns
      // about: the response must not carry it to the agent either.
      return new Response(`{"token":"${VALUE}"}`, { status: 200 });
    }),
  );

  assert.equal(seen!.url, 'https://api.github.com/user');
  assert.equal(seen!.auth, `Bearer ${VALUE}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.includes(VALUE), false);
  assert.equal(result.body.includes('***'), true);
  assert.equal(JSON.stringify(result).includes(VALUE), false);

  const log = dbApi.listSecretAccess(secret.id);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.outcome, 'ok');
  assert.equal(log[0]?.kind, 'broker');
  assert.equal(log[0]?.agent, 'timon.coder');
  assert.equal(JSON.stringify(log).includes(VALUE), false);
});

test('a host outside the allowlist is refused and journalled, without a call', async () => {
  const secret = brokered({ hosts: ['api.github.com'] });
  let called = false;
  await assert.rejects(
    () => brokerHttpCall(
      { identity: secret.name, host: 'evil.example', path: '/x' },
      caller,
      deps(async () => { called = true; return new Response('', { status: 200 }); }),
    ),
    (e: BrokerDeniedError) => e.code === 'host-denied',
  );
  assert.equal(called, false);
  assert.equal(dbApi.listSecretAccess(secret.id)[0]?.outcome, 'denied');
});

test('`api.github.com.evil.example` is refused — suffix, not substring', async () => {
  const secret = brokered({ hosts: ['github.com'] });
  for (const host of ['api.github.com.evil.example', 'evilgithub.com', 'github.com.evil.example']) {
    await assert.rejects(
      () => brokerHttpCall({ identity: secret.name, host, path: '/x' }, caller, deps()),
      (e: BrokerDeniedError) => e.code === 'host-denied',
      host,
    );
  }
  // …while the real subdomain still works.
  const ok = await brokerHttpCall({ identity: secret.name, host: 'api.github.com', path: '/x' }, caller, deps());
  assert.equal(ok.host, 'api.github.com');
});

test('a path cannot smuggle another host past the allowlist', async () => {
  const secret = brokered({ hosts: ['api.github.com'] });
  let target = '';
  await brokerHttpCall(
    { identity: secret.name, path: '//evil.example/x' },
    caller,
    deps(async (url) => { target = String(url); return new Response('', { status: 200 }); }),
  );
  // Concatenation keeps the allowed host; `new URL(path, base)` would have
  // resolved to evil.example with the allowlist check already passed.
  assert.equal(new URL(target).hostname, 'api.github.com');

  await assert.rejects(
    () => brokerHttpCall({ identity: secret.name, path: 'https://evil.example/x' }, caller, deps()),
    (e: BrokerDeniedError) => e.code === 'bad-request',
  );
});

test('a call without a grant is refused AND journalled `denied`', async () => {
  const secret = brokered({ grants: [['agent', 'someone.else']] });
  await assert.rejects(
    () => brokerHttpCall({ identity: secret.name, path: '/x' }, caller, deps()),
    (e: BrokerDeniedError) => e.code === 'no-grant',
  );
  const log = dbApi.listSecretAccess(secret.id);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.outcome, 'denied');
  assert.equal(log[0]?.detail, 'no grant for this mission');
});

test('an unknown identity is refused without inventing a journal line', async () => {
  await assert.rejects(
    () => brokerHttpCall({ identity: 'NEVER_STORED', path: '/x' }, caller, deps()),
    (e: BrokerDeniedError) => e.code === 'unknown-identity',
  );
});

test('redirects are not followed — an allowlisted host cannot forward the token', async () => {
  const secret = brokered();
  let redirectMode: RequestRedirect | undefined;
  const result = await brokerHttpCall(
    { identity: secret.name, path: '/x' },
    caller,
    deps(async (_url, init) => {
      redirectMode = init?.redirect;
      return new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } });
    }),
  );
  assert.equal(redirectMode, 'manual');
  assert.equal(result.status, 302);
  // The 3xx is handed back as-is; the response headers are not, so the agent
  // learns it was redirected without the daemon having chased it.
  assert.equal(Object.keys(result).sort().join(','), 'body,host,status');
});

test('a caller ceiling refusing the final URL stops the call before the value is opened (TODO #531, 4-B)', async () => {
  const secret = brokered({ hosts: ['api.github.com', 'uploads.github.com'], grants: [['agent', 'plugin:acme']] });
  let opened = 0;
  let fetched = 0;
  const seenByCeiling: string[] = [];
  const plugin = {
    missionId: null,
    agent: 'plugin:acme',
    project: null,
    allowTarget: (url: URL) => {
      seenByCeiling.push(url.href);
      return url.hostname === 'api.github.com' ? null : `host \`${url.hostname}\` is not in pluginPolicy.http.allow`;
    },
  };
  const counting = {
    openValue: () => { opened += 1; return VALUE; },
    fetchImpl: (async () => { fetched += 1; return new Response('{}', { status: 200 }); }) as typeof fetch,
  };
  await assert.rejects(
    () => brokerHttpCall({ identity: secret.name, path: '/x', host: 'uploads.github.com' }, plugin, counting),
    (e) => e instanceof BrokerDeniedError && e.code === 'policy-denied' && /pluginPolicy/.test(e.message),
  );
  assert.equal(opened, 0, 'no decryption');
  assert.equal(fetched, 0, 'no network');
  // The ceiling judges the URL the broker built, not something the caller wrote.
  assert.deepEqual(seenByCeiling, ['https://uploads.github.com/x']);
  assert.equal(dbApi.listSecretAccess(secret.id)[0]?.outcome, 'denied');

  // Inside all three — grant, identity hosts, ceiling — the call goes through.
  const ok = await brokerHttpCall({ identity: secret.name, path: '/y' }, plugin, counting);
  assert.equal(ok.status, 200);
  assert.equal(opened, 1);
  assert.equal(fetched, 1);
});

test('an agent call carries no ceiling: its behaviour is unchanged', async () => {
  const secret = brokered({ hosts: ['api.github.com'] });
  const result = await brokerHttpCall({ identity: secret.name, path: '/user' }, caller, deps());
  assert.equal(result.status, 200);
});

test('the agent cannot override the injected header', async () => {
  const secret = brokered();
  let auth: string | null = null;
  await brokerHttpCall(
    { identity: secret.name, path: '/x', headers: { authorization: 'Bearer forged', 'x-trace': '1' } },
    caller,
    deps(async (_url, init) => {
      auth = new Headers(init?.headers).get('authorization');
      return new Response('', { status: 200 });
    }),
  );
  assert.equal(auth, `Bearer ${VALUE}`);
});

test('a `git` identity does not serve HTTP calls', async () => {
  const secret = brokered({ spec: JSON.stringify({ type: 'git', hosts: ['github.com'] }) });
  await assert.rejects(
    () => brokerHttpCall({ identity: secret.name, path: '/x' }, caller, deps()),
    (e: BrokerDeniedError) => e.code === 'wrong-type',
  );
  assert.equal(dbApi.listSecretAccess(secret.id)[0]?.outcome, 'denied');
});

test('a value straddling MAX_BODY is scrubbed before the limit, never half-leaked', async () => {
  const secret = brokered();
  // The value starts 8 bytes before the cutoff, so a slice-then-scrub would
  // keep `VALUE.slice(0, 8)` — which does not match `VALUE`, so it would ride
  // back to the agent. Scrub-then-slice replaces the whole token first.
  const prefix = 'x'.repeat(MAX_BODY - 8);
  const raw = `${prefix}${VALUE}tail`;
  const result = await brokerHttpCall(
    { identity: secret.name, path: '/x' },
    caller,
    deps(async () => new Response(raw, { status: 200 })),
  );
  assert.equal(result.body.includes(VALUE), false);
  assert.equal(
    result.body.includes(VALUE.slice(0, 8)),
    false,
    'slicing before scrub would leak the first 8 characters of the value',
  );
  assert.equal(result.body.includes('***'), true);
  assert.ok(result.body.length <= MAX_BODY);
});

test('a decrypt failure is journalled with a constant detail, and never calls out', async () => {
  const secret = brokered();
  let called = false;
  await assert.rejects(
    () => brokerHttpCall(
      { identity: secret.name, path: '/x' },
      caller,
      {
        openValue: () => { throw new Error(`cannot open ${VALUE}`); },
        fetchImpl: async () => { called = true; return new Response('', { status: 200 }); },
      },
    ),
    (e: BrokerDeniedError) => e.code === 'bad-spec' && !e.message.includes(VALUE),
  );
  assert.equal(called, false);
  const log = dbApi.listSecretAccess(secret.id);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.outcome, 'denied');
  assert.equal(log[0]?.detail, 'decrypt-failed');
  assert.equal(JSON.stringify(log).includes(VALUE), false);
});

test('an unreadable response body is journalled with a constant detail', async () => {
  const secret = brokered();
  await assert.rejects(
    () => brokerHttpCall(
      { identity: secret.name, path: '/x' },
      caller,
      {
        openValue: () => VALUE,
        fetchImpl: async () => ({
          status: 200,
          text: async () => { throw new Error(`body contained ${VALUE}`); },
        } as unknown as Response),
      },
    ),
    (e: BrokerDeniedError) => e.code === 'bad-spec' && !e.message.includes(VALUE),
  );
  const log = dbApi.listSecretAccess(secret.id);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.outcome, 'denied');
  assert.equal(log[0]?.detail, 'response-unreadable');
  assert.equal(JSON.stringify(log).includes(VALUE), false);
});

test('a brokered secret is never returned by injection resolution (non-regression S.4)', () => {
  const secret = brokered();
  const injectable = resolveSecretsFor({ ...caller, secrets: dbApi.listSecrets() });
  assert.equal(injectable.some((s) => s.name === secret.name), false);
  // The same row IS reachable as a broker identity — the two resolutions are
  // mirror images, and only one of them ever feeds an environment.
  assert.ok(resolveBrokerSecret({ name: secret.name, ...caller, secrets: dbApi.listSecrets() }));
});

/* ── git credential broker (§6.2, `git` type) ─────────────────────────────── */

const gitSpec = (hosts: string[], username?: string) =>
  JSON.stringify(username ? { type: 'git', hosts, username } : { type: 'git', hosts });

// One host per test: the database is shared across this file, and two git
// identities covering the same host would resolve into each other's journal.
test('a git identity answers for its host, with the declared username', () => {
  const secret = brokered({ spec: gitSpec(['forge-a.example'], 'x-access-token') });
  const cred = brokerGitCredential('forge-a.example', caller, deps());
  assert.deepEqual(cred, { username: 'x-access-token', password: VALUE });
  assert.equal(dbApi.listSecretAccess(secret.id)[0]?.outcome, 'ok');
});

test('a git identity answers for a subdomain, never for a lookalike host', () => {
  const secret = brokered({ spec: gitSpec(['forge-b.example']) });
  assert.equal(brokerGitCredential('git.forge-b.example', caller, deps()).password, VALUE);
  for (const host of ['forge-b.example.evil.example', 'evilforge-b.example']) {
    assert.throws(
      () => brokerGitCredential(host, caller, deps()),
      (e: BrokerDeniedError) => e.code === 'unknown-identity',
      host,
    );
  }
  assert.equal(dbApi.listSecretAccess(secret.id).length, 1, 'a probe on another host writes no line');
});

test('a git probe on a host nobody covers writes no journal line at all', () => {
  brokered({ spec: gitSpec(['forge-c.example']) });
  const total = () => dbApi.listSecrets().reduce((n, s) => n + dbApi.listSecretAccess(s.id).length, 0);
  const before = total();
  assert.throws(
    () => brokerGitCredential('nobody-covers-this.example', caller, deps()),
    (e: BrokerDeniedError) => e.code === 'unknown-identity',
  );
  assert.equal(total(), before, 'a probe matching no secret is not an access on any secret');
});

test('a git identity without a grant for this mission is refused AND journalled', () => {
  const secret = brokered({ spec: gitSpec(['forge-d.example']), grants: [['agent', 'someone.else']] });
  assert.throws(
    () => brokerGitCredential('forge-d.example', caller, deps()),
    (e: BrokerDeniedError) => e.code === 'no-grant',
  );
  const log = dbApi.listSecretAccess(secret.id);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.outcome, 'denied');
});

test('a git decrypt failure is journalled with a constant detail', () => {
  const secret = brokered({ spec: gitSpec(['forge-decrypt.example']) });
  assert.throws(
    () => brokerGitCredential('forge-decrypt.example', caller, {
      openValue: () => { throw new Error(`cannot open ${VALUE}`); },
    }),
    (e: BrokerDeniedError) => e.code === 'bad-spec' && !e.message.includes(VALUE),
  );
  const log = dbApi.listSecretAccess(secret.id);
  assert.equal(log[0]?.detail, 'decrypt-failed');
  assert.equal(JSON.stringify(log).includes(VALUE), false);
});

test('an http identity never answers git', () => {
  const http = brokered({ hosts: ['forge-e.example'] });
  assert.throws(
    () => brokerGitCredential('forge-e.example', caller, deps()),
    (e: BrokerDeniedError) => e.code === 'unknown-identity',
  );
  assert.equal(dbApi.listSecretAccess(http.id).length, 0);
});
