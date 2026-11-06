// The publication guard of the generated references. Its job is to keep the
// licence design out of the public docs, not to strike words the public
// contract needs: plugin packages and webhook formats are signed with Ed25519,
// and a global ban on the word would have failed the first generated page that
// documented them (TODO #546).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertPublishable} from './doc-policy.mjs';

test('the licence design stays out of generated pages', () => {
  for (const line of [
    'The licence token is signed with Ed25519.',
    'Ed25519 verification of the licence at startup.',
    'Each licence JWT carries claims.',
  ]) {
    assert.throws(() => assertPublishable(line, 'page.md'), /Publication policy/, line);
  }
});

test('Ed25519 stays publishable where the public contract uses it', () => {
  for (const line of [
    'Timon verifies Ed25519 signatures over package contents.',
    'A webhook format with `kind: "ed25519"` checks the sender\'s public key.',
  ]) {
    assert.doesNotThrow(() => assertPublishable(line, 'page.md'), line);
  }
});
