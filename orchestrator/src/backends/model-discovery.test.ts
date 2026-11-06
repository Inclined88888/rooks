/**
 * Découverte des modèles amont — ce qui doit rester vrai quoi qu'il arrive au
 * réseau.
 *
 * Le contrat testé n'est pas "on sait parser du JSON", c'est la POLITIQUE de
 * dégradation : un provider injoignable, muet ou incohérent ne doit jamais
 * vider un menu ni faire disparaître un modèle que l'utilisateur pourrait
 * choisir. Sans ces tests, la panne se voit en production sous forme de
 * sélecteur vide, symptôme muet.
 *
 * `node --test --import tsx src/backends/model-discovery.test.ts` (ou `npm test`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { refreshModels, discoveredModels, discoveryError } from './model-discovery.js';
import type { BackendProfile } from './types.js';

/** Profil minimal, un id différent par test : l'état de découverte est un
 *  cache module indexé par id, deux tests qui partageraient l'id partageraient
 *  le cache (et donc le TTL déjà consommé). */
function profileOf(id: string): BackendProfile {
  return {
    id,
    dialect: 'codex',
    label: id,
    defaultModel: 'known-a',
    models: [
      { slug: 'known-a', label: 'Known A', presetLabel: 'A', presetRank: 10, contextWindow: 128_000 },
      { slug: 'known-b', label: 'Known B' },
    ],
    modelsEndpoint: { url: 'https://example.invalid/v1/models', format: 'openai' },
  };
}

/** Remplace `fetch` le temps d'un test et le restaure ensuite. */
async function withFetch(
  impl: () => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('les slugs viennent de l\'amont, les métadonnées restent locales', async () => {
  const p = profileOf('disco-merge');
  await withFetch(
    async () => jsonResponse({ data: [{ id: 'known-a' }, { id: 'brand-new' }] }),
    async () => {
      await refreshModels(p);
      const models = discoveredModels(p.id);
      assert.ok(models);
      // `known-b` a disparu de l'amont → il disparaît du menu : c'est tout
      // l'intérêt, ne plus proposer un modèle retiré.
      assert.deepEqual(models.map((m) => m.slug), ['known-a', 'brand-new']);
      // Ce que l'amont ne sait pas (preset, fenêtre de contexte) survit.
      assert.equal(models[0]?.presetLabel, 'A');
      assert.equal(models[0]?.contextWindow, 128_000);
      // Un modèle inconnu du repo n'invente aucune métadonnée.
      assert.equal(models[1]?.label, 'brand-new');
      assert.equal(models[1]?.contextWindow, undefined);
      assert.equal(discoveryError(p.id), null);
    },
  );
});

test('un endpoint en panne laisse la liste statique, jamais une liste vide', async () => {
  const p = profileOf('disco-http-500');
  await withFetch(
    async () => jsonResponse({ error: 'boom' }, 500),
    async () => {
      await refreshModels(p);
      // null = "rien de découvert" → l'appelant retombe sur profile.models.
      assert.equal(discoveredModels(p.id), null);
      assert.match(discoveryError(p.id) ?? '', /500/);
    },
  );
});

test('une réponse vide ou illisible est traitée comme une panne', async () => {
  for (const [id, body] of [
    ['disco-empty', { data: [] }],
    ['disco-shape', { models: ['a'] }],
  ] as const) {
    const p = profileOf(id);
    await withFetch(
      async () => jsonResponse(body),
      async () => {
        await refreshModels(p);
        assert.equal(discoveredModels(p.id), null, id);
        assert.ok(discoveryError(p.id), id);
      },
    );
  }
});

test('une découverte réussie survit à une panne ultérieure', async () => {
  const p = profileOf('disco-sticky');
  await withFetch(
    async () => jsonResponse({ data: [{ id: 'known-a' }] }),
    async () => { await refreshModels(p); },
  );
  assert.deepEqual(discoveredModels(p.id)?.map((m) => m.slug), ['known-a']);
  await withFetch(
    async () => { throw new Error('réseau coupé'); },
    async () => { await refreshModels(p, true); },
  );
  // L'état précédent tient : mieux vaut une liste d'hier qu'aucune liste.
  assert.deepEqual(discoveredModels(p.id)?.map((m) => m.slug), ['known-a']);
  assert.match(discoveryError(p.id) ?? '', /réseau coupé/);
});

test('sans endpoint déclaré, aucune requête n\'est tentée', async () => {
  const p: BackendProfile = { ...profileOf('disco-none'), modelsEndpoint: undefined };
  let called = false;
  await withFetch(
    async () => { called = true; return jsonResponse({ data: [] }); },
    async () => { await refreshModels(p, true); },
  );
  assert.equal(called, false);
  assert.equal(discoveredModels(p.id), null);
});

test('le TTL évite de re-solliciter l\'amont à chaque lecture', async () => {
  const p = profileOf('disco-ttl');
  let calls = 0;
  await withFetch(
    async () => { calls += 1; return jsonResponse({ data: [{ id: 'known-a' }] }); },
    async () => {
      await refreshModels(p);
      await refreshModels(p);
      await refreshModels(p);
      assert.equal(calls, 1);
      // `force` court-circuite le TTL — c'est ce que fait le boot.
      await refreshModels(p, true);
      assert.equal(calls, 2);
    },
  );
});

test('a dialect probe feeds the catalogue like an endpoint, and fails the same way', async () => {
  const { modelsEndpoint: _dropped, ...base } = profileOf('disco-probe');
  const p: BackendProfile = base;
  await refreshModels(p, true, async () => ['known-b', 'org-only']);
  assert.deepEqual(discoveredModels('disco-probe')?.map((m) => m.slug), ['known-b', 'org-only']);

  // A probe that cannot tell leaves the last good list in place.
  await refreshModels(p, true, async () => { throw new Error('not logged in'); });
  assert.deepEqual(discoveredModels('disco-probe')?.map((m) => m.slug), ['known-b', 'org-only']);
  assert.equal(discoveryError('disco-probe'), 'not logged in');

  // Neither an endpoint nor a probe: nothing to refresh.
  await refreshModels({ ...p, id: 'disco-none' }, true);
  assert.equal(discoveredModels('disco-none'), null);
});

test('the levels a probe reports reach the catalogue; the profile\'s own levels win', async () => {
  const { modelsEndpoint: _dropped, ...base } = profileOf('disco-levels');
  const p: BackendProfile = {
    ...base,
    models: [
      { slug: 'known-a', label: 'Known A' },
      { slug: 'known-b', label: 'Known B', supportedReasoningLevels: ['low'] },
    ],
  };
  await refreshModels(p, true, async () => [
    { slug: 'known-a', supportedReasoningLevels: ['low', 'high'] },
    { slug: 'known-b', supportedReasoningLevels: ['max'] },
    { slug: 'org-only', supportedReasoningLevels: ['high'] },
    'plain',
  ]);
  const found = discoveredModels('disco-levels');
  assert.deepEqual(found?.map((m) => [m.slug, m.supportedReasoningLevels]), [
    ['known-a', ['low', 'high']],
    ['known-b', ['low']],
    ['org-only', ['high']],
    ['plain', undefined],
  ]);
});
