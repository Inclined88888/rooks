/**
 * Output redaction in degraded mode (SECRETS-VAULT.md §4.4 + §7).
 *
 * Its own TIMON_HOME, set before any Timon module loads and deliberately WITHOUT
 * a `secret-key` file — hence the dynamic imports rather than `test-home.js`
 * (static imports are hoisted, an assignment in this file would run after them).
 *
 * What it pins: when the master key is missing, sealed values become unreadable
 * and therefore unredactable, but that must not take the rest of the filter down
 * with it. A legacy plaintext value (§10.4) needs no key at all, and it is the
 * most exposed one there is — it has to keep being masked whatever the order the
 * rows come back in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-test-degraded-'));

const { SECRET_KEY_FILE } = await import('../paths.js');
const { redactText } = await import('./redact.js');
const { dbApi } = await import('../db.js');

test('no master key: sealed values are lost, plaintext ones are still masked', () => {
  assert.equal(existsSync(SECRET_KEY_FILE), false, 'this case is only meaningful without a key');

  // Sealed FIRST, so a loop that gave up on the first unreadable row would drop
  // the plaintext one behind it — the bug this case exists for.
  dbApi.createSecret({
    name: 'SEALED_TOKEN',
    value_enc: 'enc:1:aXY=:dGFn:Y2lwaGVy',
    mode: 'inject',
  });
  dbApi.createSecret({ name: 'LEGACY_TOKEN', value_enc: 'legacy-plaintext-value', mode: 'inject' });

  assert.equal(redactText('carrying legacy-plaintext-value along'), 'carrying *** along');
  // And the filter did not blow up on the unreadable row.
  assert.equal(redactText('nothing to see'), 'nothing to see');
});
