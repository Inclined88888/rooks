/**
 * Declared backend capabilities as the UI reads them: all true until the
 * catalogue says otherwise, a "Remote" chip for a backend that does not work
 * in Rooks's folder, and nothing at all for one that can do everything.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  backendLimits,
  capabilitiesFor,
  DEFAULT_BACKEND_CAPABILITIES,
  type BackendCatalog,
  type CatalogBackend,
} from './backends';
import { setLocale } from './i18n';
import { BackendLimitsBadge } from '../components/backend-limits-badge';

Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

const claude: CatalogBackend = {
  id: 'claude', label: 'Claude', models: [], defaultModel: null,
  capabilities: { worktree: true, rooksMcp: true, attachments: true },
};
const gateway: CatalogBackend = {
  id: 'gateway', label: 'Gateway', models: [], defaultModel: null,
  capabilities: { worktree: false, rooksMcp: false, attachments: false },
};
const noFiles: CatalogBackend = {
  id: 'no-files', label: 'No files', models: [], defaultModel: null,
  capabilities: { worktree: true, rooksMcp: true, attachments: false },
};
const older: CatalogBackend = { id: 'older', label: 'Older daemon', models: [], defaultModel: null };
const catalog: BackendCatalog = { backends: [claude, gateway, noFiles, older], defaultBackend: 'claude' };

test('an unknown backend, an empty catalogue or an older daemon read as all true', () => {
  assert.deepEqual(capabilitiesFor({ backends: [], defaultBackend: 'claude' }, 'claude'), DEFAULT_BACKEND_CAPABILITIES);
  assert.deepEqual(capabilitiesFor(catalog, 'older'), DEFAULT_BACKEND_CAPABILITIES);
  assert.deepEqual(capabilitiesFor(catalog, 'nobody'), DEFAULT_BACKEND_CAPABILITIES);
});

test('the limits list what a backend declared it cannot do, in a stable order', () => {
  assert.deepEqual(backendLimits(catalog, 'claude'), []);
  assert.deepEqual(backendLimits(catalog, 'gateway'), ['worktree', 'rooksMcp', 'attachments']);
  assert.deepEqual(backendLimits(catalog, 'no-files'), ['attachments']);
});

test('the chip says Remote for an agent outside Rooks\'s folder, Limited otherwise, nothing when complete', () => {
  setLocale('en');
  assert.equal(renderToStaticMarkup(React.createElement(BackendLimitsBadge, { catalog, backend: 'claude' })), '');
  const remote = renderToStaticMarkup(React.createElement(BackendLimitsBadge, { catalog, backend: 'gateway' }));
  assert.match(remote, />Remote</);
  assert.match(remote, /receive attached files/);
  const limited = renderToStaticMarkup(React.createElement(BackendLimitsBadge, { catalog, backend: 'no-files' }));
  assert.match(limited, />Limited</);
  assert.doesNotMatch(limited, /Rooks&#x27;s folder/);
});
