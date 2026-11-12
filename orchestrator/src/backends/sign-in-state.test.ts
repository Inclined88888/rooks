/** What the daemon knows of each provider's sign-in, and how a turn outranks the provider's own check. */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { mountOfficialProviders, stubCliBinaries } = await import('../../tests/helpers/official-providers.js');
await stubCliBinaries('claude', 'codex');
await mountOfficialProviders();
const {
  noteProviderSignedIn, noteProviderSignedOut, primeProviderSignIn, providerSignedIn, providerSignedOut,
  refreshProviderSignIn, resetProviderSignInForTest, setSignInEnv,
} = await import('./sign-in-state.js');
const { tryDefaultBackendName } = await import('./index.js');
const { mainAgentAuthEnv } = await import('../doctor.js');
const { getAgent } = await import('../agent.js');
const { agentDir } = await import('../paths.js');
const { mkdirSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { invalidateSettingsCache } = await import('../settings.js');

test('nothing is asked before the boot wires the environment: the verdict stays unknown', async () => {
  resetProviderSignInForTest();
  assert.equal(await refreshProviderSignIn('claude'), null);
  assert.equal(providerSignedIn('claude'), null);
  assert.equal(providerSignedOut('claude'), false, 'unknown is never signed out');
});

test('the provider check answers, and a turn outranks it', async () => {
  resetProviderSignInForTest();
  setSignInEnv(() => ({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-token-long-enough' }));
  await primeProviderSignIn(['claude']);
  assert.equal(providerSignedIn('claude'), true, 'a token in the environment is a sign-in');
  noteProviderSignedOut('claude');
  assert.equal(providerSignedOut('claude'), true);
  await refreshProviderSignIn('claude');
  assert.equal(providerSignedOut('claude'), true, 'the CLI refusing a turn wins over a background check, for a while');
  await refreshProviderSignIn('claude', true);
  assert.equal(providerSignedIn('claude'), true, 'a person asking again (setup\'s Try again) gets the fresh answer at once');
  noteProviderSignedIn('claude');
  assert.equal(providerSignedIn('claude'), true);
  resetProviderSignInForTest();
});

test('an environment that itself asks the sign-in state does not recurse (TIM-0119)', async () => {
  resetProviderSignInForTest();
  let calls = 0;
  // `mainAgentAuthEnv` resolved the main agent's default backend, which asks
  // `providerSignedOut` for every provider: with no verdict yet, that walk
  // re-entered the refresh until the stack overflowed.
  setSignInEnv(() => {
    calls++;
    assert.equal(providerSignedOut('claude'), false, 'a refresh in flight answers unknown, not another refresh');
    assert.equal(tryDefaultBackendName(), 'claude');
    return { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-token-long-enough' };
  });
  try {
    assert.equal(providerSignedIn('claude'), null, 'the first caller gets no verdict and starts the refresh');
    await primeProviderSignIn(['claude']);
    // Each provider refreshes at most a few times here (claude, then the codex
    // the default-backend walk asks about): a bounded count, not a stack.
    assert.ok(calls <= 6, `bounded refreshes, got ${calls}`);
    assert.equal(providerSignedIn('claude'), true);
  } finally {
    resetProviderSignInForTest();
  }
});

test('the real boot wiring: a main agent without a backend of its own does not loop (TIM-0119)', async () => {
  // What both testers had: `_main` renamed or seeded without `backend`, so
  // reading it resolves the default backend, which asks the sign-in state.
  // The boot wires `mainAgentAuthEnv` as the refresh's environment; a unit
  // test with a static environment never walked this cycle.
  resetProviderSignInForTest();
  mkdirSync(agentDir('_main'), { recursive: true });
  writeFileSync(join(agentDir('_main'), 'config.json'), '{}\n');
  // The overflow itself is swallowed by the refresh's own catch (the Windows
  // tester's daemon froze instead of dying): only a count tells the loop.
  let evaluations = 0;
  setSignInEnv(() => { evaluations++; return mainAgentAuthEnv(); });
  try {
    assert.equal(getAgent('_main')?.backend, 'claude', 'the default backend is resolved, not stored');
    assert.doesNotThrow(() => providerSignedIn('claude'));
    await primeProviderSignIn(['claude', 'codex']);
    assert.ok(evaluations <= 6, `a few refreshes, not a walk down the stack: ${evaluations} evaluations`);
    assert.equal(typeof tryDefaultBackendName(), 'string');
  } finally {
    resetProviderSignInForTest();
  }
});

test('an account instance is never tracked here: it carries its own status', () => {
  resetProviderSignInForTest();
  noteProviderSignedOut('claude@acct-1');
  assert.equal(providerSignedIn('claude@acct-1'), null);
});

test('the default backend skips a signed-out provider and honours the preferred one', () => {
  resetProviderSignInForTest();
  const before = tryDefaultBackendName();
  assert.equal(before, 'claude', 'claude serves the daemon\'s own tasks: it leads by default');
  noteProviderSignedOut('claude');
  assert.equal(tryDefaultBackendName(), 'codex', 'a signed-out claude is no default');
  process.env.ROOKS_PREFERRED_BACKEND = 'claude';
  invalidateSettingsCache();
  try {
    assert.equal(tryDefaultBackendName(), 'codex', 'a preferred provider that is signed out is passed over');
    noteProviderSignedIn('claude');
    process.env.ROOKS_PREFERRED_BACKEND = 'codex';
    invalidateSettingsCache();
    assert.equal(tryDefaultBackendName(), 'codex', 'the preferred provider wins over the usual order');
  } finally {
    delete process.env.ROOKS_PREFERRED_BACKEND;
    invalidateSettingsCache();
    resetProviderSignInForTest();
  }
});
