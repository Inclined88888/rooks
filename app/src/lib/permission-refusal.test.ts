import assert from 'node:assert/strict';
import test from 'node:test';
import { permissionAccess, refusalText, responseErrorText } from './permission-refusal';

const lacks = {
  error: 'forbidden', code: 'account_lacks_permission', permission: 'projects:manage',
  reason: 'this account does not hold projects:manage', hint: 'Ask an administrator.', caller: 'session',
};

test('a missing permission is named, not printed as "forbidden" (TODO #560)', () => {
  const text = refusalText(lacks) ?? '';
  assert.match(text, /projects:manage/);
  assert.doesNotMatch(text, /^forbidden$/);
  assert.equal(responseErrorText(lacks, 'fallback'), text);
});

test('any other refusal shows the daemon reason and hint', () => {
  const body = { error: 'forbidden', code: 'not_in_mission_cap', permission: 'x:y', reason: 'mission tokens never carry x:y', hint: 'Do it from the UI.' };
  assert.equal(refusalText(body), 'mission tokens never carry x:y — Do it from the UI.');
  assert.equal(refusalText({ error: 'forbidden', reason: 'operation refused', hint: null }), 'operation refused');
  assert.match(refusalText({ error: 'forbidden' }) ?? '', /not allowed/);
});

test('a body that is not a refusal keeps its error, else the fallback', () => {
  assert.equal(refusalText({ error: 'branch not found' }), null);
  assert.equal(responseErrorText({ error: 'branch not found' }, 'fallback'), 'branch not found');
  assert.equal(responseErrorText({}, 'HTTP 500'), 'HTTP 500');
  assert.equal(responseErrorText(null, 'HTTP 502'), 'HTTP 502');
});

test('a gated control is enabled only when held, explained only when missing', () => {
  assert.deepEqual(permissionAccess(true, 'projects:manage'), { allowed: true, denied: null });
  assert.deepEqual(permissionAccess(null, 'projects:manage'), { allowed: false, denied: null });
  const denied = permissionAccess(false, 'projects:manage');
  assert.equal(denied.allowed, false);
  assert.match(denied.denied ?? '', /projects:manage/);
});
