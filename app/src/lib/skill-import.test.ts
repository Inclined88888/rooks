/**
 * What the UI says of a skill's reach, and the id rules it checks before the
 * request: the same as the daemon's (`orchestrator/src/skill-registry.ts`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultImportId, isImportableId, isImportableSource, skillReachesMissions } from './skill-import';

test('only Timon and project skills reach a mission; ~/.claude ones are importable', () => {
  assert.equal(skillReachesMissions('timon'), true);
  assert.equal(skillReachesMissions('project'), true);
  assert.equal(skillReachesMissions('claude-user'), false);
  assert.equal(skillReachesMissions('plugin'), false);
  assert.deepEqual((['timon', 'project', 'claude-user', 'plugin'] as const).filter(isImportableSource), ['claude-user', 'plugin']);
});

test('the default id folds the namespace; the id grammar is the Timon one', () => {
  assert.equal(defaultImportId('code-review:Review'), 'code-review-review');
  assert.equal(defaultImportId('helper'), 'helper');
  for (const ok of ['helper', 'a.b_c-1', 'x'.repeat(128)]) assert.equal(isImportableId(ok), true, ok);
  for (const bad of ['', '.hidden', '-x', 'trailing.', 'UPPER', 'a/b', 'a\\b', 'a:b', '..', 'x'.repeat(129)]) {
    assert.equal(isImportableId(bad), false, bad);
  }
});
