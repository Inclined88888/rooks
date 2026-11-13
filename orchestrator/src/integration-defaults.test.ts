import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSetting } from './settings.js';
import { getVaultGraph, getVaultNote } from './vault-graph.js';
import { getVaultDisc } from './vault-disc.js';
import { vfDbPath } from './video-factory.js';

test('empty integrations do not discover personal data', async () => {
  setSetting('ROOKS_BRAIN_VAULT', '');
  setSetting('VF_DB_PATH', '');
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected request'); };
  try {
    assert.equal(calls, 0);
    assert.equal(getVaultGraph().nodes.length, 0);
    assert.equal(getVaultDisc().nodes.length, 0);
    assert.equal(getVaultNote('private'), null);
    assert.equal(vfDbPath(), '');
  } finally { globalThis.fetch = original; }
});

test('changing and clearing a configured vault never serves the previous cache', () => {
  const first = mkdtempSync(join(tmpdir(), 'rooks-vault-first-'));
  const second = mkdtempSync(join(tmpdir(), 'rooks-vault-second-'));
  try {
    writeFileSync(join(first, 'first.md'), '# First');
    writeFileSync(join(second, 'second.md'), '# Second');
    setSetting('ROOKS_BRAIN_VAULT', first);
    assert.equal(getVaultGraph().nodes[0]?.id, 'first');
    assert.equal(getVaultDisc().nodes.length, 1);
    setSetting('ROOKS_BRAIN_VAULT', second);
    assert.equal(getVaultGraph().nodes[0]?.id, 'second');
    assert.equal(getVaultNote('first'), null);
    assert.equal(getVaultDisc().nodes[0]?.id, 'second.md');
    setSetting('ROOKS_BRAIN_VAULT', '');
    assert.equal(getVaultGraph().nodes.length, 0);
    assert.equal(getVaultDisc().nodes.length, 0);
  } finally {
    setSetting('ROOKS_BRAIN_VAULT', '');
    getVaultGraph(); getVaultDisc();
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
