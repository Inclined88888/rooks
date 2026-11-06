import assert from 'node:assert/strict';
import test from 'node:test';
import { initials, nodeCaption, nodeInitials, truncate } from './graph-labels';

test("a project's orchestrator is captioned by its project, once", () => {
  const lead = { id: 'video-factory.main', kind: 'orchestrator', project: 'video-factory' };
  assert.equal(nodeCaption(lead), 'video-factory');
  assert.equal(nodeInitials(lead), 'VF');
});

test('a role keeps its full name, the main agent and a pole theirs', () => {
  assert.equal(nodeCaption({ id: 'timon.coder', kind: 'coder', project: 'timon' }), 'timon.coder');
  assert.equal(nodeCaption({ id: '_main.perso', kind: 'orchestrator', isMain: true, project: 'perso' }), '_main.perso');
  assert.equal(nodeCaption({ id: 'workspace:design-studio', kind: 'workspace', pole: { name: 'Design Studio' } }), 'Design Studio');
  assert.equal(nodeInitials({ id: 'workspace:design-studio', kind: 'workspace', pole: { name: 'Design Studio' } }), 'DS');
});

test('long captions are cut, initials never exceed two letters', () => {
  assert.equal(truncate('timon.workflow-architect'), 'timon.workflow-ar…');
  assert.equal(truncate('timon.workflow-architect').length, 18);
  assert.equal(initials('_main.perso'), 'MP');
  assert.equal(initials('timon'), 'TI');
  assert.equal(initials('...'), '?');
});
