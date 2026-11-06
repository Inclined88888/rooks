import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { loadPackOffers, packPluginIds } from './plugin-packs';

const entry = (id: string) => ({ id, label: id, languages: { codes: ['fr'], mode: 'forced' }, files: [{ sizeBytes: 10 }] });

test('only the active plugins that declare a pack are read', () => {
  assert.deepEqual(packPluginIds({
    plugins: [
      { id: 'acme', state: 'active', dictation: { engines: [], models: 'dictation-models.json' } },
      { id: 'off', state: 'disabled', dictation: { engines: [], models: 'dictation-models.json' } },
      { id: 'refused', state: 'skipped', dictation: { engines: [], models: 'dictation-models.json' } },
      { id: 'engine', state: 'active', dictation: { engines: [{ id: 'x' }], models: null } },
      { id: '@timon/settings', state: 'active', dictation: { engines: [], models: 'x.json' } },
      { id: 'plain', state: 'active' },
    ],
  }), ['acme']);
  assert.deepEqual(packPluginIds(null), []);
  assert.deepEqual(packPluginIds({ plugins: 'x' }), []);
});

test('the offers of every pack; a pack that cannot be read is left out, not the list', async () => {
  const urls: string[] = [];
  const offers = await loadPackOffers(async (url) => {
    urls.push(url);
    if (url === '/api/ui/plugins') {
      return Response.json({ plugins: ['acme', 'beta', 'gamma'].map((id) => ({ id, state: 'active', dictation: { engines: [], models: 'm.json' } })) });
    }
    if (url.includes('/acme/')) return Response.json({ pluginId: 'acme', models: [entry('acme.fr')] });
    if (url.includes('/beta/')) return Response.json({ error: 'invalid' }, { status: 422 });
    throw new Error('offline');
  });
  assert.deepEqual(offers.map((offer) => offer.id), ['acme.fr']);
  assert.deepEqual(urls, [
    '/api/ui/plugins', '/api/ui/plugins/acme/-/dictation-models', '/api/ui/plugins/beta/-/dictation-models', '/api/ui/plugins/gamma/-/dictation-models',
  ]);
  assert.deepEqual(await loadPackOffers(async () => { throw new Error('offline'); }), []);
});
