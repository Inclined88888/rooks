import assert from 'node:assert/strict';
import test from 'node:test';
import { peekStoredLayout } from '@/hooks/use-stored-layout';

// TIM-0105: the rail stands in the value this document already read while it
// waits for its view key. With nothing read, it must get `undefined`, which is
// not the same answer as "read, nothing stored" (`null`).
test('peekStoredLayout has nothing for an unknown or missing scope', () => {
  assert.equal(peekStoredLayout(null), undefined);
  assert.equal(peekStoredLayout('v2.never-read'), undefined);
});
