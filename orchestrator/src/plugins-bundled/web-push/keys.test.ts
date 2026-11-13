/**
 * Where the VAPID keys come from (TODO #545). The private key is read from the
 * env, then from the vault where SECRETS.md tells the operator to store it —
 * never from whatever `.env` sits next to the daemon's working directory.
 */
// Isolates ROOKS_HOME BEFORE any module touching Rooks state (see test-home.ts).
import '../../test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVapidKeys } from './push.js';
import { createSecret } from '../../secrets/store.js';
import { setActiveModules, resetActiveModules } from '../../kernel/module-state.js';

const KEYS = ['ROOKS_VAPID_PUBLIC_KEY', 'ROOKS_VAPID_PRIVATE_KEY', 'ROOKS_VAPID_SUBJECT'] as const;
for (const key of KEYS) delete process.env[key];

const cwd = process.cwd();
after(() => {
  process.chdir(cwd);
  resetActiveModules();
  for (const key of KEYS) delete process.env[key];
});

test('a .env above or beside the working directory is never read', () => {
  // The layout the old fallback looked at: `<cwd>/../.env` and `<cwd>/.env`.
  const root = mkdtempSync(join(tmpdir(), 'rooks-vapid-env-'));
  const work = join(root, 'orchestrator');
  mkdirSync(work);
  const planted = 'ROOKS_VAPID_PUBLIC_KEY=planted-public\nROOKS_VAPID_PRIVATE_KEY=planted-private\n';
  writeFileSync(join(root, '.env'), planted);
  writeFileSync(join(work, '.env'), planted);
  process.chdir(work);
  try {
    assert.equal(resolveVapidKeys(), null);
    assert.equal(process.env.ROOKS_VAPID_PRIVATE_KEY, undefined, 'nothing copied into the environment');
  } finally {
    process.chdir(cwd);
  }
});

test('the env alone is enough, with the default subject', () => {
  process.env.ROOKS_VAPID_PUBLIC_KEY = 'env-public';
  process.env.ROOKS_VAPID_PRIVATE_KEY = 'env-private';
  try {
    assert.deepEqual(resolveVapidKeys(), {
      publicKey: 'env-public', privateKey: 'env-private', subject: 'mailto:rooks@localhost',
    });
  } finally {
    delete process.env.ROOKS_VAPID_PUBLIC_KEY;
    delete process.env.ROOKS_VAPID_PRIVATE_KEY;
  }
});

test('a private key stored in the vault (daemon only, no grant) completes the pair', () => {
  process.env.ROOKS_VAPID_PUBLIC_KEY = 'env-public';
  createSecret({ name: 'ROOKS_VAPID_PRIVATE_KEY', value: 'vault-private' });
  assert.equal(resolveVapidKeys()?.privateKey, 'vault-private');

  // The env still wins over the vault.
  process.env.ROOKS_VAPID_PRIVATE_KEY = 'env-private';
  assert.equal(resolveVapidKeys()?.privateKey, 'env-private');
  delete process.env.ROOKS_VAPID_PRIVATE_KEY;

  // A vault switched off hands nothing out.
  setActiveModules([]);
  assert.equal(resolveVapidKeys(), null);
  resetActiveModules();
  delete process.env.ROOKS_VAPID_PUBLIC_KEY;
});
