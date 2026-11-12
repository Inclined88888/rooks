/**
 * `ctx.usage` côté daemon : la vue agrégée des quotas et les sondes qu'un
 * plugin peut fournir (§10.15).
 *
 * Le calcul de risque, lui, n'est plus ici : il appartient au plugin qui
 * l'affiche (`examples/plugin-quota-monitor`), avec ses seuils. Le daemon rend
 * des mesures, pas un jugement.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-usage-global-test-'));
const {
  collectUsage, collectBackendUsage, collectUsageFor,
  registerUsageCollector, usageCollectorBackends, resetForcedUsageProbes,
} = await import('./usage.js');
await import('../tests/helpers/claude-provider.js');

const { PERMISSION_MODELS, RATE_LIMIT_REPORTINGS } = await import('./backends/types.js');

/** Catalogue entry of a provider brought by a plugin: no first-party probe. */
function pluginProvider(id: string) {
  return {
    id, label: id, models: [], defaultModel: null,
    permissionModel: PERMISSION_MODELS[0]!, rateLimitReporting: RATE_LIMIT_REPORTINGS[0]!,
    accountUsage: false, sessionResumable: false,
  };
}

test('une sonde de plugin couvre un backend que le produit ne mesure pas', async () => {
  const item = pluginProvider('acme-llm');
  assert.deepEqual(await collectUsageFor(item), {
    backend: 'acme-llm', label: 'acme-llm', vendor: 'acme-llm', brand: null,
    available: false, usage: null,
  }, 'sans sonde : indisponible et SANS chiffre, jamais un zéro');

  const remove = registerUsageCollector('acme-plugin', 'acme-llm', async () => ({
    windows: { week: { utilization: 42, resets_at: null } },
    extra: null,
  }));
  assert.deepEqual(usageCollectorBackends(), ['acme-llm']);
  const measured = await collectUsageFor(item);
  assert.equal(measured.available, true);
  assert.equal(measured.usage?.windows.week?.utilization, 42);

  // Deux sondes pour le même compte diraient deux vérités : la seconde est
  // refusée en nommant le propriétaire de la première.
  assert.throws(() => registerUsageCollector('other-plugin', 'acme-llm', async () => null), /acme-plugin/);

  remove();
  assert.deepEqual(usageCollectorBackends(), []);
  assert.equal((await collectUsageFor(item)).available, false, 'sonde retirée, plus aucun chiffre');
});

test('a ↻ reaches the probe as `force`, at most once per floor, and only a literal true counts', async () => {
  resetForcedUsageProbes();
  const item = pluginProvider('refresh-llm');
  const calls: unknown[][] = [];
  const remove = registerUsageCollector('acme-plugin', 'refresh-llm', async (...args) => {
    calls.push(args);
    return { windows: {}, extra: null };
  });
  try {
    await collectUsageFor(item);
    await collectUsageFor(item, { force: 'yes' } as never);
    await collectUsageFor(item, null as never);
    await collectUsageFor(item, { force: true });
    await collectUsageFor(item, { force: true });
    assert.deepEqual(calls, [[], [], [], [{ force: true }], []],
      'polling sees the call it always saw; a second ↻ inside the floor serves the cache');
    resetForcedUsageProbes();
    await collectUsageFor(item, { force: true });
    assert.deepEqual(calls.at(-1), [{ force: true }], 'past the floor, a ↻ is honoured again');
  } finally {
    remove();
    resetForcedUsageProbes();
  }
});

test("une sonde de plugin ne remplace pas la mesure du produit", async () => {
  // `claude` porte la sonde native : un plugin ne peut pas s'y substituer.
  const native = await collectBackendUsage('claude');
  assert.ok(native, 'claude est un backend actif');
  const remove = registerUsageCollector('acme-plugin', 'claude', async () => ({
    windows: { week: { utilization: 7, resets_at: null } },
    extra: null,
  }));
  const after = await collectBackendUsage('claude');
  assert.notEqual(after?.usage?.windows.week?.utilization, 7);
  remove();
});

test('une sonde de plugin qui échoue rend une erreur, pas un chiffre', async () => {
  const item = pluginProvider('flaky-llm');
  const remove = registerUsageCollector('acme-plugin', 'flaky-llm', async () => {
    throw new Error('endpoint injoignable');
  });
  const entry = await collectUsageFor(item);
  assert.equal(entry.available, false);
  assert.equal(entry.usage, null);
  assert.match(entry.error ?? '', /injoignable/);
  remove();
});

test('une session CLI absente n\'est pas une erreur de sonde', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rooks-usage-collect-no-oauth-'));
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const { resetClaudeUsageCache } = await import('../tests/helpers/claude-provider.js');
  resetClaudeUsageCache();
  try {
    const entry = await collectBackendUsage('claude');
    assert.ok(entry);
    assert.equal(entry.available, false);
    assert.equal(entry.usage, null);
    assert.equal(entry.connected, false);
    assert.equal(entry.reason, 'not_signed_in');
    assert.equal(entry.error, undefined);
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
  }
});

test('un backend inconnu rend null, jamais une entrée fabriquée', async () => {
  assert.equal(await collectBackendUsage('backend-qui-nexiste-pas'), null);
  const entries = await collectUsage();
  assert.ok(entries.length > 0, 'au moins un backend actif');
  for (const entry of entries) {
    assert.equal(typeof entry.backend, 'string');
    // Trois états, jamais un zéro de substitution.
    if (!entry.available) assert.equal(entry.usage, null);
  }
});
