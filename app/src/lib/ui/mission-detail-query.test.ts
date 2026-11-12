import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardedMissionQuery } from './mission-detail-query';

const forward = (query: string): string => forwardedMissionQuery(new URLSearchParams(query));

test('the status view and the chat paging reach the daemon', () => {
  assert.equal(forward(''), '');
  assert.equal(forward('view=status'), '?view=status');
  assert.equal(forward('tail=300'), '?tail=300');
  assert.equal(forward('tail=300&before=1234'), '?tail=300&before=1234');
  assert.equal(forward('after=987'), '?after=987');
});

test('the raw view and anything that is not a plain integer stay behind', () => {
  assert.equal(forward('view=raw'), '');
  assert.equal(forward('view=chat&tail=5'), '?tail=5');
  assert.equal(forward('tail=-1&before=1e3'), '');
  assert.equal(forward('tail=5%26view%3Draw'), '');
  assert.equal(forward('other=1&tail=2'), '?tail=2');
  assert.equal(forward('after=1x'), '');
});
