import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveArchitectAgent } from '../plugins-client/workflows/architect-agent';
import { diffWorkflow, newNodeId, outPortsFor, placeUnpositioned, removeNodes, tidyDefinition, type WorkflowDefinition } from '../plugins-client/workflows/types';
import { defaultConfig, presentationFor } from '../plugins-client/workflows/node-catalog';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('workflow tidy lays nodes in deterministic layers', () => {
  const definition: WorkflowDefinition = { schemaVersion: 1, nodes: [{ id: 'a', type: 'trigger.manual', config: {} }, { id: 'b', type: 'agent', config: {} }, { id: 'c', type: 'agent', config: {} }], edges: [{ id: 'e1', from: 'a', fromPort: 'out', to: 'b' }, { id: 'e2', from: 'a', fromPort: 'out', to: 'c' }], variables: [], settings: {} };
  const tidy = tidyDefinition(definition);
  const [a, b, c] = tidy.nodes;
  assert.ok((b?.position?.x ?? 0) > (a?.position?.x ?? 0));
  assert.equal(b?.position?.x, c?.position?.x);
  assert.notEqual(b?.position?.y, c?.position?.y);
  // A fan-out is centred on its source column.
  assert.equal(a?.position?.y, ((b?.position?.y ?? 0) + (c?.position?.y ?? 0)) / 2);
});

test('workflow tidy orders a column by its sources so edges do not cross', () => {
  // Definition order puts d above c, but c is fed by a (top) and d by b (bottom).
  const definition: WorkflowDefinition = { schemaVersion: 1, nodes: [{ id: 'a', type: 'trigger.manual', config: {} }, { id: 'b', type: 'trigger.manual', config: {} }, { id: 'd', type: 'agent', config: {} }, { id: 'c', type: 'agent', config: {} }], edges: [{ id: 'e1', from: 'a', fromPort: 'out', to: 'c' }, { id: 'e2', from: 'b', fromPort: 'out', to: 'd' }], variables: [], settings: {} };
  const at = new Map(tidyDefinition(definition).nodes.map((node) => [node.id, node.position!]));
  assert.ok(at.get('a')!.y < at.get('b')!.y);
  assert.ok(at.get('c')!.y < at.get('d')!.y, 'c follows its source a, above d');
  // A branch keeps the order of its edges: true above false.
  const branch: WorkflowDefinition = { schemaVersion: 1, nodes: [{ id: 's', type: 'trigger.manual', config: {} }, { id: 'when', type: 'condition', config: {} }, { id: 'no', type: 'output', config: {} }, { id: 'yes', type: 'output', config: {} }], edges: [{ id: 'e0', from: 's', fromPort: 'out', to: 'when' }, { id: 'e1', from: 'when', fromPort: 'true', to: 'yes' }, { id: 'e2', from: 'when', fromPort: 'false', to: 'no' }], variables: [], settings: {} };
  const laid = new Map(tidyDefinition(branch).nodes.map((node) => [node.id, node.position!]));
  assert.ok(laid.get('yes')!.y < laid.get('no')!.y);
});

test('nodes without a position are laid out instead of piling up at the origin', () => {
  const bare: WorkflowDefinition = { schemaVersion: 1, nodes: [{ id: 'a', type: 'trigger.manual', config: {} }, { id: 'b', type: 'agent', config: {} }, { id: 'c', type: 'agent', config: {} }], edges: [{ id: 'e1', from: 'a', fromPort: 'out', to: 'b' }, { id: 'e2', from: 'a', fromPort: 'out', to: 'c' }], variables: [], settings: {} };
  const placed = placeUnpositioned(bare);
  const spots = new Set(placed.nodes.map((node) => `${node.position?.x},${node.position?.y}`));
  assert.equal(spots.size, 3, 'three distinct spots');
  assert.deepEqual(placed.nodes.map((node) => node.position), tidyDefinition(bare).nodes.map((node) => node.position));
  // Every node placed: the very same object, nothing recomputed.
  assert.equal(placeUnpositioned(placed), placed);
  // Mixed: placed nodes stay put, the others go below them.
  const mixed: WorkflowDefinition = { ...bare, nodes: [{ ...bare.nodes[0]!, position: { x: 500, y: 600 } }, bare.nodes[1]!, bare.nodes[2]!] };
  const result = placeUnpositioned(mixed);
  assert.deepEqual(result.nodes[0]!.position, { x: 500, y: 600 });
  for (const node of result.nodes.slice(1)) assert.ok(node.position!.y > 600, `${node.id} below the placed node`);
});

test('the http node has a face, a form and a default config the daemon accepts as a draft', () => {
  const http = presentationFor('http');
  assert.equal(http.category, 'action');
  assert.deepEqual(http.fields.map((field) => field.key), ['url', 'method', 'headers', 'body', 'timeoutMs', 'allowPrivateNetwork']);
  assert.equal(http.fields.find((field) => field.key === 'allowPrivateNetwork')?.kind, 'boolean');
  assert.deepEqual(http.summary({ url: 'https://api.example.com/x', method: 'POST' }), ['POST https://api.example.com/x']);
  assert.deepEqual(defaultConfig('http'), { url: 'https://', method: 'GET' });
});

test('workflow editing helpers keep the graph consistent', () => {
  const definition: WorkflowDefinition = { schemaVersion: 1, nodes: [{ id: 'start', type: 'trigger.manual', config: {} }, { id: 'agent-1', type: 'agent', config: { routes: ['escalate'] } }, { id: 'switch-1', type: 'switch', config: { on: 'x', cases: [{ port: 'bug', value: 'bug' }] } }], edges: [{ id: 'e1', from: 'start', fromPort: 'out', to: 'agent-1' }, { id: 'e2', from: 'agent-1', fromPort: 'escalate', to: 'switch-1' }], variables: [], settings: {} };
  assert.equal(newNodeId('agent', definition), 'agent-2');
  assert.equal(newNodeId('trigger.schedule', definition), 'schedule-1');
  assert.deepEqual(outPortsFor(definition.nodes[1]!, { type: 'agent', ports: { out: ['done', 'failed'] } }), ['escalate', 'done', 'failed']);
  assert.deepEqual(outPortsFor(definition.nodes[2]!, { type: 'switch', ports: { out: ['default'] } }), ['bug', 'default']);
  const pruned = removeNodes(definition, ['agent-1']);
  assert.deepEqual(pruned.nodes.map((node) => node.id), ['start', 'switch-1']);
  assert.deepEqual(pruned.edges, []);
});

test('workflow builder has no hard-coded model slugs and reads the live catalogues', () => {
  for (const file of ['../plugins-client/workflows/builder.tsx', '../plugins-client/workflows/node-settings.tsx', '../plugins-client/workflows/node-catalog.ts', '../plugins-client/workflows/agent-facets.tsx']) {
    assert.doesNotMatch(read(file), /gpt-|claude-|sonnet|opus|haiku/i, file);
  }
  const settings = read('../plugins-client/workflows/node-settings.tsx');
  assert.match(settings, /useBackendCatalog/);
  assert.match(settings, /\/api\/ui\/agents/);
  assert.match(settings, /\/api\/ui\/skills/);
  assert.match(settings, /\/api\/ui\/mcp/);
  // The right rail is the ordinary chat: it owns no model list, no second
  // thread, and no agent name of its own — the user's orchestrator answers.
  const panel = read('../plugins-client/workflows/architect-chat.tsx');
  assert.doesNotMatch(panel, /gpt-|claude-|sonnet|opus|haiku/i);
  assert.doesNotMatch(panel, /rooks\.workflow-architect/);
  assert.match(panel, /ChatClient/);
  assert.match(panel, /resolveArchitectAgent/);
  assert.match(panel, /workflow_propose/);
  assert.match(panel, /workflow_proposal/);
  assert.match(panel, /decide\('accept'\)/);
  assert.match(panel, /decide\('reject'\)/);
});

test('workflow routes read the Next pathname and the ui proxy, never window.location', () => {
  const entry = read('../plugins-client/workflows.tsx');
  assert.match(entry, /usePathname/);
  assert.doesNotMatch(entry, /window\.location/);
  assert.match(entry, /route: '\/trace\/\*'/);
  assert.match(entry, /key: 'workflow-runs'/);
  const builder = read('../plugins-client/workflows/builder.tsx');
  assert.match(builder, /\/api\/ui\/workflows\/\$\{encodeURIComponent\(slug\)\}/);
  assert.match(builder, /workflows\.notFound/);
  assert.doesNotMatch(builder, /fetch\(['`]\/api\/workflows/);
  const page = read('../plugins-client/workflows/page.tsx');
  assert.doesNotMatch(page, /window\.prompt/);
  assert.match(page, /DialogContent/);
  assert.match(page, /\/api\/ui\/workflows/);
  const runs = read('../plugins-client/workflows/run-page.tsx');
  assert.doesNotMatch(runs, /fetch\(['`]\/api\/workflows/);
  assert.match(runs, /sseOn\('workflow_run'/);
  assert.match(runs, /\/api\/ui\/human\//);
  const listProxy = read('../app/api/ui/workflows/route.ts');
  assert.match(listProxy, /proxyJson\('POST', '\/api\/workflows'/);
  const typesProxy = read('../app/api/ui/workflows/node-types/route.ts');
  assert.match(typesProxy, /\/api\/workflows\/node-types/);
  const daemon = read('../../../orchestrator/src/plugins-bundled/workflows/routes.ts');
  assert.match(daemon, /owner_user_id:viewerFromRequest\(req\)\?\.id/);
  // The run view draws the frozen version the daemon ships with the run.
  assert.match(daemon, /definition,nodes:dbApi\.listWorkflowRunNodes/);
  assert.match(runs, /detail\.definition/);
});

test('workflow canvas keeps stable interaction callbacks and equality guards', () => {
  const source = read('../plugins-client/workflows/workflow-canvas.tsx');
  assert.match(source, /useCallback/g);
  assert.match(source, /sameJson/);
  assert.match(source, /ReactFlowProvider/);
  // Option objects live at module scope, never inline in JSX.
  assert.doesNotMatch(source, /fitViewOptions=\{\{/);
  assert.doesNotMatch(source, /nodeTypes=\{\{/);
});

test('proposal diff lists added, removed and modified nodes', () => {
  const current: WorkflowDefinition = { schemaVersion: 1, nodes: [{ id: 'manual', type: 'trigger.manual', config: {} }, { id: 'out', type: 'output', config: { template: 'old' } }], edges: [], variables: [], settings: {} };
  const proposed: WorkflowDefinition = { schemaVersion: 1, nodes: [{ id: 'manual', type: 'trigger.manual', config: {} }, { id: 'agent', type: 'agent', config: { ref: 'w8.witness' } }, { id: 'out', type: 'output', config: { template: 'new' } }], edges: [], variables: [], settings: {} };
  assert.deepEqual(diffWorkflow(current, proposed), { added: ['agent'], removed: [], modified: ['out'] });
  assert.deepEqual(diffWorkflow(proposed, current), { added: [], removed: ['agent'], modified: ['out'] });
});

test('legacy screens expose Trace and Convert to workflow, the pipelines one Open in canvas', () => {
  const pipelines = read('../app/(main)/pipelines/pipelines-client.tsx');
  assert.match(pipelines, /workflows\.openInCanvas/);
  assert.match(pipelines, /\/trace\/\$\{run\.run\.run_id\}/);
  const routines = read('../plugins-client/routines/routines-page.tsx');
  assert.match(routines, /workflows\.convertToWorkflow/);
  assert.match(routines, /workflows\.convertConfirm/);
  const missions = read('../app/(main)/missions/missions-client.tsx');
  assert.match(missions, /MissionTrace missionId/);
});

test('every workflows i18n key exists in both locales', () => {
  const en = JSON.parse(read('../locales/en/core.json')) as { workflows: Record<string, unknown> };
  const fr = JSON.parse(read('../locales/fr/core.json')) as { workflows: Record<string, unknown> };
  const flat = (value: Record<string, unknown>, prefix = ''): string[] => Object.entries(value).flatMap(([key, item]) => (item && typeof item === 'object' ? flat(item as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`]));
  assert.deepEqual(flat(fr.workflows).sort(), flat(en.workflows).sort());
});

test('the builder resolves the assigned pilot and refuses a foreign identity, a failed request or an unassigned workflow', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const workflow = { id: 'witness', agent_name: 'pilot' };
  try {
    globalThis.fetch = async (url) => { requests.push(String(url)); return Response.json({ agent: 'pilot' }); };
    assert.equal(await resolveArchitectAgent(workflow), 'pilot');
    assert.deepEqual(requests, ['/api/ui/workflows/witness/chat-agent']);
    globalThis.fetch = async () => Response.json({ agent: '_main' });
    await assert.rejects(resolveArchitectAgent(workflow));
    globalThis.fetch = async () => Response.json({ error: 'unavailable' }, { status: 503 });
    await assert.rejects(resolveArchitectAgent(workflow));
    requests.length = 0;
    globalThis.fetch = async (url) => { requests.push(String(url)); return Response.json({ agent: 'pilot' }); };
    await assert.rejects(resolveArchitectAgent({ id: 'witness', agent_name: null }));
    assert.deepEqual(requests, [], 'no request for a workflow without a pilot');
  } finally { globalThis.fetch = originalFetch; }
});
