/** The same failures of a restore under Windows' rename, which never replaces a file. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPendingRestore,
} from './data-version.js';
import { seed, requestRestore, downgraded, liveState, leftovers, FAILING_STEPS, windowsRename } from './data-version-fixtures.js';

for (const step of FAILING_STEPS) {
  test(`with Windows' rename, a restore failing at ${step} still leaves everything untouched`, () => {
    const files = downgraded();
    seed(files, 'after the update').close();
    const before = liveState(files);
    requestRestore(files, 'pre-0.1.2', '0.1.1');
    const result = applyPendingRestore(files, '0.1.1', {
      rename: windowsRename,
      fault: (at) => { if (at === step) throw new Error(`injected at ${at}`); },
    });
    assert.equal(result?.error, `injected at ${step}`);
    assert.deepEqual(liveState(files), before);
    assert.deepEqual(leftovers(files), []);
  });
}
