import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentLlm, type BackendCatalog, type CatalogBackend } from './backends';
import { brandOfSlug } from '../components/brand-mark';

const backend = (over: Partial<CatalogBackend> & { id: string }): CatalogBackend => ({
  label: over.id, models: [], defaultModel: null, ...over,
});

const catalog: BackendCatalog = {
  defaultBackend: 'alpha',
  backends: [
    backend({ id: 'alpha', slugPrefixes: ['alpha-'] }),
    backend({ id: 'beta' }),
    backend({ id: 'alpha@acct', instanceOf: 'alpha', slugPrefixes: ['alpha-'] }),
  ],
  // Served for the providers that are installed here or not: `alpha` need not be active.
  modelBrands: [{ match: 'alpha', brand: 'alpha-brand' }, { match: 'gem', brand: 'gemini' }],
};

test('a versioned slug lights up the alias of the backend that declared its prefix', () => {
  assert.deepEqual(currentLlm(catalog, 'alpha', 'alpha-big-5-2'), { backend: 'alpha', model: 'big' });
  assert.deepEqual(currentLlm(catalog, 'alpha', 'alpha-5-2'), { backend: 'alpha', model: 'alpha-5-2' }, 'no alias to find');
  assert.deepEqual(currentLlm(catalog, 'beta', 'plain'), { backend: 'beta', model: 'plain' });
});

test('a backend value that is a model name of a provider is that provider; an empty one is the daemon\'s default', () => {
  assert.equal(currentLlm(catalog, 'alpha-legacy', null).backend, 'alpha');
  assert.equal(currentLlm(catalog, undefined, '').backend, 'alpha');
  assert.equal(currentLlm(catalog, 'unknown', '').backend, 'unknown', 'an open registry: kept as it is');
  assert.equal(currentLlm({ backends: [], defaultBackend: '' }, null, null).backend, '');
});

test('the logo of a model comes from the fragments the providers declared', () => {
  assert.equal(brandOfSlug('Alpha-Big', catalog), 'alpha-brand');
  assert.equal(brandOfSlug('gemini-3', catalog), 'gemini');
  assert.equal(brandOfSlug('mystery', catalog), null);
  assert.equal(brandOfSlug('alpha-big', { backends: [], defaultBackend: '' }), null);
  // The provider behind the fragment need not be in the catalogue (no key, not installed).
  assert.equal(brandOfSlug('alpha-big', { ...catalog, backends: [] }), 'alpha-brand');
});
