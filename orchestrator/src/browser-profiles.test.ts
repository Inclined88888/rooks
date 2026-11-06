import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dbApi } from './db.js';
import { agentConfig, agentDir } from './paths.js';
import { createBrowserProfile, getBrowserProfile, isBrowserProfileId, listBrowserProfiles, resolveBrowserProfile, resolveMissionBrowserProfile } from './browser-profiles.js';
import { parseWorkflowDraft } from './workflows/schema.js';
import { workflowNodeRuntime } from './workflows/nodes/agent.js';
await import('../tests/helpers/claude-provider.js');


const owner = () => `user-${randomUUID()}`;
const agentName = () => `agent-${randomUUID()}`;
function setConfig(name: string, cfg: object) {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(agentConfig(name), JSON.stringify(cfg));
}

test('default profiles isolate both owners and project scopes, including projectless agents', () => {
  const alice = owner(); const bob = owner();
  const general = resolveBrowserProfile({ ownerUserId: alice })!;
  assert.equal(general.id, resolveBrowserProfile({ ownerUserId: alice, agentName: agentName() })!.id);
  assert.notEqual(general.id, resolveBrowserProfile({ ownerUserId: bob })!.id);
  const project = resolveBrowserProfile({ ownerUserId: alice, project: 'client-a' })!;
  assert.notEqual(project.id, general.id);
  assert.equal(project.id, resolveBrowserProfile({ ownerUserId: alice, project: 'client-a' })!.id);
  assert.notEqual(project.id, resolveBrowserProfile({ ownerUserId: bob, project: 'client-a' })!.id);
  assert.deepEqual(project.grants, {});
  assert.ok(isBrowserProfileId(project.id));
  assert.ok(listBrowserProfiles({ id: alice, isSuperadmin: false }).every((profile) => profile.owner_user_id === alice));
  assert.equal(getBrowserProfile(project.id, { id: bob, isSuperadmin: false }), null);
});

test('an explicit missing or forbidden profile fails closed without falling back to General', () => {
  const alice = owner(); const bob = owner();
  const profile = createBrowserProfile({ name: 'CMS only' }, { id: alice, isSuperadmin: false });
  assert.throws(() => resolveBrowserProfile({ ownerUserId: bob, selection: profile.id }), /forbidden/);
  assert.throws(() => resolveBrowserProfile({ ownerUserId: alice, selection: `bp-${randomUUID()}`, workflowSlug: 'publish' }), /not found/);
  assert.throws(() => resolveBrowserProfile({ ownerUserId: alice, selection: '../other-profile' }), /not found/);
  assert.throws(() => createBrowserProfile({ name: 'Hijack', owner_user_id: bob }, { id: alice, isSuperadmin: true }), /current user/);
  assert.throws(() => resolveBrowserProfile({ ownerUserId: alice, agentName: '../outside' }), /invalid agent name/);
});

test('agent config overrides scope inheritance, while null always disables', () => {
  const user = owner(); const agent = agentName();
  const dedicated = createBrowserProfile({ name: 'Agent sessions', scope_kind: 'agent', scope_ref: agent, owner_user_id: user });
  const custom = createBrowserProfile({ name: 'Work login', owner_user_id: user });
  assert.equal(resolveBrowserProfile({ ownerUserId: user, agentName: agent, project: 'client' })!.id, dedicated.id);
  setConfig(agent, { browser_profile_id: custom.id });
  assert.equal(resolveBrowserProfile({ ownerUserId: user, agentName: agent })!.id, custom.id);
  assert.equal(resolveBrowserProfile({ ownerUserId: user, agentName: agent, selection: dedicated.id })!.id, dedicated.id);
  assert.equal(resolveBrowserProfile({ ownerUserId: user, agentName: agent, selection: null }), null);
  setConfig(agent, { browser_profile_id: null });
  assert.equal(resolveBrowserProfile({ ownerUserId: user, agentName: agent, project: 'client' }), null);
  assert.equal(resolveBrowserProfile({ ownerUserId: user, agentName: agent, selection: custom.id })!.id, custom.id);
});

test('optional grants restrict profiles to named agents or workflows, including explicit deny-all', () => {
  const user = owner(); const agent = agentName();
  const profile = createBrowserProfile({ name: 'Publisher', owner_user_id: user, grants: { workflow_slugs: ['publish-client-a'] } });
  assert.equal(resolveBrowserProfile({ ownerUserId: user, agentName: agent, workflowSlug: 'publish-client-a', selection: profile.id })!.id, profile.id);
  assert.throws(() => resolveBrowserProfile({ ownerUserId: user, agentName: agent, workflowSlug: 'publish-client-b', selection: profile.id }), /forbidden/);
  const deny = createBrowserProfile({ name: 'No agents', owner_user_id: user, grants: { agent_names: [] } });
  assert.throws(() => resolveBrowserProfile({ ownerUserId: user, agentName: agent, selection: deny.id }), /forbidden/);
  const project = resolveBrowserProfile({ ownerUserId: user, project: 'client-a' })!;
  assert.throws(() => resolveBrowserProfile({ ownerUserId: user, project: 'client-b', selection: project.id }), /forbidden/);
});

test('workflow profile selection survives schema parsing, including explicit null', () => {
  for (const value of [null, `bp-${randomUUID()}`]) {
    const definition = parseWorkflowDraft({ schemaVersion: 1, settings: { browserProfileId: value } });
    assert.equal(definition.settings.browserProfileId, value);
  }
});

test('a mission keeps its authorized project profile after the agent moves to another project', () => {
  const user = owner(); const agent = agentName();
  const initial = resolveBrowserProfile({ ownerUserId: user, agentName: agent, project: 'initial-project' })!;
  setConfig(agent, { project: 'new-project', browser_profile_id: null });
  const mission = { owner_user_id: user, agent_name: agent, browser_profile_id: initial.id, browser_profile_resolved: 1 };
  assert.equal(resolveMissionBrowserProfile(mission, { project: 'new-project' })!.id, initial.id);
  assert.equal(resolveMissionBrowserProfile({ ...mission, browser_profile_id: null }, { project: 'new-project' }), null);
  assert.throws(() => resolveMissionBrowserProfile({ ...mission, owner_user_id: owner() }), /forbidden/);
});

test('a workflow node resolves its own browser profile: the workflow default, an explicit profile, or none', () => {
  const user = owner(); const pilot = agentName(); const workflowId = randomUUID(); const runId = randomUUID(); const missionId = randomUUID();
  setConfig(pilot, { backend: 'claude', model: 'sonnet' });
  const main = createBrowserProfile({ name: 'Workflow session', owner_user_id: user });
  const limited = createBrowserProfile({ name: 'Limited session', owner_user_id: user, grants: { workflow_slugs: [workflowId] } });
  const definition = parseWorkflowDraft({ schemaVersion: 1, settings: { browserProfileId: main.id } });
  const now = Date.now();
  dbApi.insertWorkflow({ id: workflowId, slug: workflowId, name: 'Workflow', description: null, project: null, owner_user_id: user, draft: JSON.stringify(definition), published_version: null, enabled: 1, created_at: now, updated_at: now, agent_name: pilot });
  dbApi.insertWorkflowVersion({ workflow_id: workflowId, version: 1, definition: JSON.stringify(definition), published_at: now, published_by: user });
  dbApi.insertWorkflowRun({ id: runId, workflow_id: workflowId, version: 1, status: 'running', trigger: '{}', input: null, context: '{}', error: null, started_at: now, ended_at: null, owner_user_id: user, tokens_in: null, tokens_out: null, cost_usd: null });
  dbApi.createMission(missionId, pilot, 'run', undefined, user, runId, { runId, nodeId: null });
  dbApi.setMissionBrowserProfile(missionId, main.id);
  const node = { id: 'publish', type: 'agent', config: { identity: { instructions: 'Publish' } } };
  assert.equal(workflowNodeRuntime(missionId, node).browserProfileId, main.id);
  assert.equal(workflowNodeRuntime(missionId, { ...node, config: { ...node.config, browserProfileId: limited.id } }).browserProfileId, limited.id);
  assert.equal(workflowNodeRuntime(missionId, { ...node, config: { ...node.config, browserProfileId: null } }).browserProfileId, null);
  assert.throws(() => workflowNodeRuntime(missionId, { ...node, config: { ...node.config, browserProfileId: `bp-${randomUUID()}` } }), /not found/);
});
