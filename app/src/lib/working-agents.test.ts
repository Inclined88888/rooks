import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActiveAgent } from './agent-state';
import {
  DEFAULT_WORKING_AGENTS_OPTIONS,
  groupWorkingTabs,
  projectOrchestrator,
  isOrchestratorAgent,
  parseWorkingAgentsOptions,
  withWorkingAgentsOptions,
  workingAgentTabs,
  type WorkingAgentsInput,
  type WorkingAgentSource,
} from './working-agents';

const NOW = 1_000_000;

const live = (name: string, state: ActiveAgent['state'] = 'thinking', project: string | null = null, extra: Partial<ActiveAgent> = {}): ActiveAgent => (
  { name, state, mission_id: `m-${name}`, at: NOW - 5_000, pending_count: 0, project, ...extra }
);

const CONFIGURED: WorkingAgentSource[] = [
  { name: 'nova', main: true, role: null, project: null },
  { name: 'shop.orchestrator', role: 'orchestrator', project: 'shop' },
  { name: 'shop.coder', role: 'coder', project: 'shop' },
  { name: 'blog.coder', role: 'coder', project: 'blog' },
  { name: 'blog.pilot', orchestrator: true, project: 'blog' },
  { name: 'tmp-worker', orchestrator: true, ephemeral: true, project: 'blog' },
];

const input = (over: Partial<WorkingAgentsInput>): WorkingAgentsInput => ({
  active: [],
  configured: CONFIGURED,
  pins: [],
  closed: {},
  options: DEFAULT_WORKING_AGENTS_OPTIONS,
  now: NOW,
  ...over,
});

const names = (tabs: readonly ActiveAgent[]) => tabs.map((t) => t.name);

test('options default when nothing is stored, and malformed values read as their default', () => {
  assert.deepEqual(parseWorkingAgentsOptions(null), DEFAULT_WORKING_AGENTS_OPTIONS);
  assert.deepEqual(parseWorkingAgentsOptions({ pinned: ['a'] }), DEFAULT_WORKING_AGENTS_OPTIONS);
  assert.deepEqual(
    parseWorkingAgentsOptions({ options: { show: 'everything', orchestratorOnly: 'yes', groupByProject: true } }),
    { ...DEFAULT_WORKING_AGENTS_OPTIONS, groupByProject: true },
  );
});

test('changing an option keeps the pins and the other options', () => {
  const row = { pinned: ['nova'], options: { groupByProject: true } };
  const next = withWorkingAgentsOptions(row, { orchestratorOnly: true });
  assert.deepEqual(next.pinned, ['nova']);
  assert.deepEqual(parseWorkingAgentsOptions(next), { ...DEFAULT_WORKING_AGENTS_OPTIONS, groupByProject: true, orchestratorOnly: true });
});

test('an orchestrator is the main agent, the orchestrator role, or the flag on a lasting agent', () => {
  const by = (name: string) => CONFIGURED.find((a) => a.name === name)!;
  assert.ok(isOrchestratorAgent(by('nova')));
  assert.ok(isOrchestratorAgent(by('shop.orchestrator')));
  assert.ok(isOrchestratorAgent(by('blog.pilot')));
  assert.ok(!isOrchestratorAgent(by('tmp-worker')), 'an ephemeral agent is not one');
  assert.ok(!isOrchestratorAgent(by('shop.coder')));
});

test('working: the agents at work, pinned ones first in the person\'s order, the open chat kept', () => {
  const tabs = workingAgentTabs(input({
    active: [live('shop.coder'), live('blog.coder', 'done')],
    pins: ['blog.pilot', 'blog.coder'],
    currentAgent: 'nova',
    currentMission: 'm9',
  }));
  assert.deepEqual(names(tabs), ['blog.pilot', 'blog.coder', 'nova', 'shop.coder']);
  assert.equal(tabs[0]!.state, 'idle', 'a pinned agent at rest has a tab');
  assert.equal(tabs[2]!.mission_id, 'm9', 'the open chat points at its mission');
});

test('working: a tab closed by hand stays out, unless it is pinned or the open chat', () => {
  const closed = { 'shop.coder': { at: NOW, missions: ['m-shop.coder'] }, 'blog.coder': { at: NOW, missions: ['m-blog.coder'] } };
  const active = [live('shop.coder', 'thinking', 'shop', { started_at: NOW - 10_000 }), live('blog.coder', 'thinking', 'blog', { started_at: NOW - 10_000 })];
  assert.deepEqual(names(workingAgentTabs(input({ active, closed }))), []);
  assert.deepEqual(names(workingAgentTabs(input({ active, closed, pins: ['blog.coder'], currentAgent: 'shop.coder' }))), ['blog.coder', 'shop.coder']);
});

test('all: every lasting agent, at work or not, pins first', () => {
  const tabs = workingAgentTabs(input({ active: [live('shop.coder')], pins: ['blog.coder'], options: { ...DEFAULT_WORKING_AGENTS_OPTIONS, show: 'all' } }));
  assert.deepEqual(names(tabs), ['blog.coder', 'shop.coder', 'nova', 'shop.orchestrator', 'blog.pilot']);
  assert.equal(tabs.find((t) => t.name === 'shop.orchestrator')!.project, 'shop', 'a tab at rest knows its project');
});

test('orchestrators only: the main agent always, project orchestrators when they work, no other agent', () => {
  const options = { ...DEFAULT_WORKING_AGENTS_OPTIONS, orchestratorOnly: true };
  const active = [live('shop.coder'), live('shop.orchestrator', 'needs_action', 'shop')];
  assert.deepEqual(names(workingAgentTabs(input({ active, options }))), ['nova', 'shop.orchestrator']);
  assert.deepEqual(
    names(workingAgentTabs(input({ active, options, pins: ['shop.coder', 'blog.pilot'], currentAgent: 'blog.coder' }))),
    ['blog.pilot', 'nova', 'shop.orchestrator'],
    'a pinned or open non-orchestrator stays out; a pinned orchestrator comes first',
  );
  assert.deepEqual(names(workingAgentTabs(input({ options, configured: [] }))), [], 'nothing until the agents are known');
});

test('grouped by project: one entry per project, where its first tab stood, with the most pressing state', () => {
  const tabs = [
    live('blog.pilot', 'idle', 'blog'),
    live('shop.coder', 'thinking', 'shop', { pending_count: 1 }),
    live('nova', 'done', null),
    live('blog.coder', 'needs_action', 'blog', { pending_count: 2 }),
    live('shop.orchestrator', 'done', 'shop'),
  ];
  const entries = groupWorkingTabs(tabs);
  assert.deepEqual(entries.map((e) => (e.kind === 'project' ? `project:${e.group.project}` : `agent:${e.agent.name}`)), ['project:blog', 'project:shop', 'agent:nova'], 'an agent of no project keeps its own tab, in no group');
  const groups = entries.flatMap((e) => (e.kind === 'project' ? [e.group] : []));
  assert.deepEqual(groups.map((g) => g.state), ['needs_action', 'thinking']);
  assert.deepEqual(groups.map((g) => g.pending), [2, 1]);
  assert.deepEqual(groups.map((g) => g.working), [1, 1], 'a done agent is not at work');
  assert.deepEqual(names(groups[0]!.agents), ['blog.pilot', 'blog.coder']);
});

test('grouped by project: pinned projects first, in pin order, even with no agent at work', () => {
  const tabs = [live('shop.coder', 'thinking', 'shop'), live('nova', 'done', null), live('blog.coder', 'done', 'blog')];
  const entries = groupWorkingTabs(tabs, ['docs', 'blog']);
  assert.deepEqual(
    entries.map((e) => (e.kind === 'project' ? `${e.pinned ? 'pinned:' : ''}${e.group.project}` : `agent:${e.agent.name}`)),
    ['pinned:docs', 'pinned:blog', 'shop', 'agent:nova'],
  );
  const docs = entries[0]!;
  assert.ok(docs.kind === 'project' && docs.group.agents.length === 0 && docs.group.state === 'idle', 'a pinned project at rest has an empty group');
});

test('a project\'s tab opens its orchestrator: the role first, else the flag', () => {
  const configured = [
    { name: 'shop.coder', role: 'coder', project: 'shop' },
    { name: 'shop.lead', orchestrator: true, project: 'shop' },
    { name: 'shop.main', role: 'orchestrator', project: 'shop' },
    { name: 'blog.lead', orchestrator: true, project: 'blog' },
    { name: 'blog.temp', orchestrator: true, ephemeral: true, project: 'blog' },
    { name: 'nova', main: true, project: null },
  ];
  assert.equal(projectOrchestrator(configured, 'shop'), 'shop.main');
  assert.equal(projectOrchestrator(configured, 'blog'), 'blog.lead');
  assert.equal(projectOrchestrator(configured, 'docs'), null);
});
