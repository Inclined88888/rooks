import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnverifiedBadge, unverifiedHint } from './unverified-badge';

/**
 * A provider that says what it has not seen work gets a chip, with each subject
 * and the provider's own sentence on hover; one that claims nothing gets none.
 */
test('no claim, no chip', () => {
  assert.equal(unverifiedHint({}), null);
  assert.equal(unverifiedHint({ unverified: [] }), null);
  assert.equal(renderToStaticMarkup(React.createElement(UnverifiedBadge, { entry: {} })), '');
});

test('the chip lists each subject with the provider\'s sentence', () => {
  const entry = { unverified: [
    { subject: 'mcp' as const, note: 'Declared through the session, never seen honoured.' },
    { subject: 'extension-requests' as const, note: 'Reconstructed from the documentation.' },
  ] };
  const hint = unverifiedHint(entry)!;
  const lines = hint.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /^• .+: Declared through the session, never seen honoured\.$/);
  assert.match(lines[2]!, /^• .+: Reconstructed from the documentation\.$/);
  const html = renderToStaticMarkup(React.createElement(UnverifiedBadge, { entry }));
  assert.match(html, /data-unverified="mcp extension-requests"/);
});
