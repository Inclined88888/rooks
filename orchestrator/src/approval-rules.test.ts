/**
 * "Allow for this session" / "Always allow" on a claude card (TODO #288): Rooks
 * keeps the wider Allow itself and answers the next request with the same
 * motif. What matters most here is where it must NOT reach: another mission,
 * another agent, another owner, a tool the agent denies, an agent's own token.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import express from 'express';

await import('../tests/helpers/paid-license.js');

const { db, dbApi } = await import('./db.js');
const { upsertAgent, deleteAgent } = await import('./agent.js');
const { registerRoutes: registerMissionRoutes } = await import('./plugins-bundled/missions/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('./plugins-bundled/agents/routes.js');
const { listPending, requestPermission, resolvePermission } = await import('./permissions.js');
const { approvalMotif } = await import('./approval-rules.js');
const { permissionHost } = await import('./mission-session.js');

const owner = createTestAccount(dbApi, { email: 'owner@example.com', name: 'owner', passwordHash: 'x', isSuperadmin: true });
const other = createTestAccount(dbApi, { email: 'other@example.com', name: 'other', passwordHash: 'x', isSuperadmin: true });

const AGENT = 'approvals.coder';
const SIBLING = 'approvals.writer';
const GUARDED = 'approvals.guarded';
for (const name of [AGENT, SIBLING]) {
  upsertAgent({ name, system_prompt: 'witness', config: { backend: 'claude', cwd: tmpdir(), skills: [], mcp_servers: [] } });
}
upsertAgent({
  name: GUARDED, system_prompt: 'witness',
  config: { backend: 'claude', cwd: tmpdir(), skills: [], mcp_servers: [], disallowed_tools: ['WebFetch', 'Bash(rm:*)'] },
});

let missionSeq = 0;
function mission(agent: string, userId: string): string {
  const id = `m-approval-${++missionSeq}`;
  dbApi.createMission(id, agent, 'work', undefined, userId);
  return id;
}

type Fake = { kind: 'daemon-token' | 'session' | 'api-token'; userId?: string; missionId?: string };
const app = express();
app.use(express.json());
// The real lookup lives in http/auth.ts; here the caller's identity is the test input.
app.use((req, _res, next) => {
  const raw = req.header('x-test-auth');
  if (raw) {
    const fake = JSON.parse(raw) as Fake;
    const user = fake.userId ? dbApi.getUserById(fake.userId) ?? null : null;
    req.auth = {
      kind: fake.kind, user,
      isSuperadmin: fake.kind === 'daemon-token' || !!user?.is_superadmin,
      missionId: fake.missionId ?? null,
    };
  }
  next();
});
registerMissionRoutes(app);
registerAgentRoutes(app);
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const ownerSession: Fake = { kind: 'session', userId: owner.id };

function call(method: string, path: string, auth: Fake | null, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { 'x-test-auth': JSON.stringify(auth) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let toolSeq = 0;
function ask(missionId: string, agent: string, toolName: string, input: unknown, scopes?: readonly ('session' | 'always')[]) {
  const toolUseId = `tu-approval-${++toolSeq}`;
  // As the claude shim's route asks.
  const decision = requestPermission({
    mission_id: missionId, agent, tool_name: toolName, input, tool_use_id: toolUseId, novaScopes: true,
    ...(scopes ? { scopes } : {}),
  });
  const card = listPending(missionId).find((p) => p.tool_use_id === toolUseId);
  return { decision, card, toolUseId };
}

/** Answers the card from the owner's browser, with a scope. */
async function allowWith(cardId: string, scope: 'session' | 'always', auth: Fake = ownerSession): Promise<Response> {
  return call('POST', `/api/permissions/${cardId}/resolve`, auth, { behavior: 'allow', scope, origin: 'ui_card_allow' });
}

function autoAllowed(missionId: string, toolUseId: string): boolean {
  return dbApi.listEvents(missionId).some((e) => e.type === 'permission_auto_allowed'
    && (JSON.parse(e.payload) as { tool_use_id?: string }).tool_use_id === toolUseId);
}

test('the motif: the tool name and what the call reaches, never the tool name alone', () => {
  assert.deepEqual(approvalMotif('Bash', { command: '  npm test  ' }), { tool_name: 'Bash', command: 'npm test' });
  assert.deepEqual(approvalMotif('Edit', { file_path: '/src/a.ts', old_string: 'x', new_string: 'y' }), { tool_name: 'Edit', command: '/src/a.ts' });
  assert.deepEqual(approvalMotif('NotebookEdit', { notebook_path: 'n.ipynb' }), { tool_name: 'NotebookEdit', command: 'n.ipynb' });
  assert.deepEqual(approvalMotif('WebFetch', { url: 'https://Docs.Example.com/a?q=1', prompt: 'p' }), { tool_name: 'WebFetch', command: 'domain:docs.example.com' });
  assert.deepEqual(
    approvalMotif('mcp__browser__navigate', { url: 'https://a.test', options: { b: 1, a: 2 } }),
    { tool_name: 'mcp__browser__navigate', command: '{"options":{"a":2,"b":1},"url":"https://a.test"}' },
    'any other tool: its exact input, keys sorted',
  );
  for (const [tool, input] of [
    ['Bash', {}], ['Write', { content: 'x' }], ['Edit', { file_path: '  ' }],
    ['WebFetch', { url: 'file:///etc/passwd' }], ['WebFetch', { url: 'not a url' }], ['WebFetch', {}],
    ['mcp__x__y', { blob: 'x'.repeat(5000) }],
  ] as const) {
    assert.equal(approvalMotif(tool, input), null, `${tool} ${JSON.stringify(input).slice(0, 40)}: what it reaches cannot be read, never remembered as "any"`);
  }
  assert.equal(approvalMotif('ask_user', { questions: [] }), null, 'a form is answered, not approved');
});

test('a claude card offers session and always, and says what they cover', () => {
  const m = mission(AGENT, owner.id);
  const { card } = ask(m, AGENT, 'Bash', { command: 'npm run lint' });
  assert.ok(card);
  assert.deepEqual(card.scopes, ['session', 'always']);
  assert.equal(card.remembers, 'Bash(npm run lint)');
  const event = dbApi.listEvents(m).find((e) => e.type === 'permission_request');
  assert.equal((JSON.parse(event!.payload) as { approval_motif?: string }).approval_motif, 'Bash(npm run lint)');
  resolvePermission(card.id, { behavior: 'deny', message: 'no' });
});

test('always: the next request with the same motif is allowed without a card, the agent never sees a scope', async () => {
  const first = mission(AGENT, owner.id);
  const { decision, card } = ask(first, AGENT, 'Bash', { command: 'npm test' });
  assert.ok(card);
  assert.equal((await allowWith(card.id, 'always')).status, 200);
  const answer = await decision;
  assert.equal(answer.behavior, 'allow');
  assert.equal('scope' in answer, false, 'the claude CLI gets a plain Allow');

  // Another mission of the same agent and owner: no card.
  const second = mission(AGENT, owner.id);
  const again = ask(second, AGENT, 'Bash', { command: 'npm test' });
  assert.equal(again.card, undefined);
  assert.equal((await again.decision).behavior, 'allow');
  assert.ok(autoAllowed(second, again.toolUseId), 'the auto-allow is traced');

  // Another command is another motif.
  const different = ask(second, AGENT, 'Bash', { command: 'npm test && rm -rf ~' });
  assert.ok(different.card, 'a different command still asks');
  resolvePermission(different.card.id, { behavior: 'deny', message: 'no' });
});

test('always does not reach another agent, nor another owner', async () => {
  const m = mission(AGENT, owner.id);
  const { decision, card } = ask(m, AGENT, 'WebSearch', { query: 'x' });
  assert.ok(card);
  await allowWith(card.id, 'always');
  await decision;

  const sibling = ask(mission(SIBLING, owner.id), SIBLING, 'WebSearch', { query: 'x' });
  assert.ok(sibling.card, 'another agent of the same owner asks');
  resolvePermission(sibling.card.id, { behavior: 'deny', message: 'no' });

  const stranger = ask(mission(AGENT, other.id), AGENT, 'WebSearch', { query: 'x' });
  assert.ok(stranger.card, "another owner's mission on the same agent asks");
  resolvePermission(stranger.card.id, { behavior: 'deny', message: 'no' });
});

test('session holds for its mission only, and dies with it', async () => {
  const m = mission(AGENT, owner.id);
  const { decision, card } = ask(m, AGENT, 'Write', { file_path: 'x', content: '1' });
  assert.ok(card);
  assert.equal(card.remembers, 'Write(x)');
  await allowWith(card.id, 'session');
  await decision;

  const same = ask(m, AGENT, 'Write', { file_path: 'x', content: '2' });
  assert.equal(same.card, undefined, 'the same mission does not ask again for the same file');
  assert.equal((await same.decision).behavior, 'allow');

  const sibling = ask(m, AGENT, 'Write', { file_path: 'y', content: '1' });
  assert.ok(sibling.card, 'another file of the same mission asks');
  resolvePermission(sibling.card.id, { behavior: 'deny', message: 'no' });

  const next = ask(mission(AGENT, owner.id), AGENT, 'Write', { file_path: 'x' });
  assert.ok(next.card, 'a new mission asks again');
  resolvePermission(next.card.id, { behavior: 'deny', message: 'no' });

  assert.equal(countRules(m), 1);
  dbApi.finishMission(m, 'completed', 0);
  assert.equal(countRules(m), 0, 'the session rule is gone with its mission');
});

function countRules(missionId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM approval_rules WHERE mission_id = ?`).get(missionId) as { n: number }).n;
}
const hashOf = (subject: string) => createHash('sha256').update(subject).digest('hex');

test('always on a file, an address or an MCP call covers that one, not every one of the tool', async () => {
  const cases: { tool: string; granted: unknown; covered: unknown; other: unknown; label: string }[] = [
    { tool: 'Edit', granted: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }, covered: { file_path: '/p/a.ts', old_string: 'c', new_string: 'd' }, other: { file_path: '/home/me/.bashrc', old_string: 'a', new_string: 'b' }, label: 'Edit(/p/a.ts)' },
    { tool: 'WebFetch', granted: { url: 'https://docs.example.com/a', prompt: 'x' }, covered: { url: 'https://docs.example.com/b?page=2', prompt: 'y' }, other: { url: 'https://attacker.example.net/?d=secret', prompt: 'x' }, label: 'WebFetch(domain:docs.example.com)' },
    { tool: 'mcp__browser__navigate', granted: { url: 'https://a.test', wait: true }, covered: { wait: true, url: 'https://a.test' }, other: { url: 'https://attacker.test' }, label: 'mcp__browser__navigate({"url":"https://a.test","wait":true})' },
  ];
  for (const c of cases) {
    const first = ask(mission(AGENT, owner.id), AGENT, c.tool, c.granted);
    assert.ok(first.card, c.tool);
    assert.equal(first.card.remembers, c.label, `${c.tool}: the card says what "always" covers`);
    await allowWith(first.card.id, 'always');
    await first.decision;

    const later = mission(AGENT, owner.id);
    const covered = ask(later, AGENT, c.tool, c.covered);
    assert.equal(covered.card, undefined, `${c.tool}: the same file / domain / call is allowed`);
    assert.equal((await covered.decision).behavior, 'allow');
    const other = ask(later, AGENT, c.tool, c.other);
    assert.ok(other.card, `${c.tool}: another file / domain / call still asks`);
    resolvePermission(other.card.id, { behavior: 'deny', message: 'no' });
  }
});

test('a call whose file or address cannot be read gets no wider Allow', () => {
  const m = mission(AGENT, owner.id);
  for (const [tool, input] of [['Write', { content: 'x' }], ['WebFetch', { url: 'file:///etc/shadow' }]] as const) {
    const { card } = ask(m, AGENT, tool, input);
    assert.ok(card, tool);
    assert.equal(card.scopes, undefined, `${tool}: only "this once"`);
    assert.equal(card.remembers, undefined, tool);
    resolvePermission(card.id, { behavior: 'deny', message: 'no' });
  }
});

test('a rule on the tool name alone, and a session rule of an ended mission, are pruned and answer nothing', () => {
  const m = mission(AGENT, owner.id);
  dbApi.insertApprovalRule({
    id: 'rule-tool-wide', scope: 'always', owner_user_id: owner.id, agent: AGENT, mission_id: null,
    tool_name: 'Write', command: null, command_hash: null,
  });
  const before = ask(m, AGENT, 'Write', { file_path: '/etc/cron.d/x', content: 'x' });
  assert.ok(before.card, 'a tool-wide rule written before the change answers nothing');
  resolvePermission(before.card.id, { behavior: 'deny', message: 'no' });

  const ended = mission(AGENT, owner.id);
  db.prepare(`UPDATE missions SET status = 'completed' WHERE id = ?`).run(ended);
  dbApi.insertApprovalRule({
    id: 'rule-stale-session', scope: 'session', owner_user_id: owner.id, agent: AGENT, mission_id: ended,
    tool_name: 'Bash', command: 'make', command_hash: hashOf('make'),
  });
  const live = mission(AGENT, owner.id);
  dbApi.insertApprovalRule({
    id: 'rule-live-session', scope: 'session', owner_user_id: owner.id, agent: AGENT, mission_id: live,
    tool_name: 'Bash', command: 'make', command_hash: hashOf('make'),
  });
  assert.ok(dbApi.pruneApprovalRules() >= 2);
  const ids = (db.prepare(`SELECT id FROM approval_rules`).all() as { id: string }[]).map((r) => r.id);
  assert.equal(ids.includes('rule-tool-wide'), false);
  assert.equal(ids.includes('rule-stale-session'), false);
  assert.equal(ids.includes('rule-live-session'), true, 'a running mission keeps its session rules');
});

test("a tool the agent denies is never offered nor auto-allowed", async () => {
  const m = mission(GUARDED, owner.id);
  const { card } = ask(m, GUARDED, 'WebFetch', { url: 'https://example.com' });
  assert.ok(card);
  assert.equal(card.scopes, undefined, 'no wider Allow on a red-listed tool');
  resolvePermission(card.id, { behavior: 'deny', message: 'no' });

  // Even a rule that exists (written before the red list) is not honoured.
  dbApi.insertApprovalRule({
    id: 'rule-guarded', scope: 'always', owner_user_id: owner.id, agent: GUARDED, mission_id: null,
    tool_name: 'WebFetch', command: 'domain:example.com', command_hash: hashOf('domain:example.com'),
  });
  const again = ask(m, GUARDED, 'WebFetch', { url: 'https://example.com' });
  assert.ok(again.card, 'the red list wins over a remembered approval');
  resolvePermission(again.card.id, { behavior: 'deny', message: 'no' });
});

test('an agent that keeps its own scopes gets them back, and Rooks remembers nothing', async () => {
  const m = mission(SIBLING, owner.id);
  const { decision, card } = ask(m, SIBLING, 'Glob', { pattern: '*' }, ['session', 'always']);
  assert.ok(card);
  assert.equal(card.remembers, undefined);
  await allowWith(card.id, 'always');
  const answer = await decision;
  assert.equal(answer.behavior === 'allow' && answer.scope, 'always');
  assert.equal(dbApi.listAlwaysApprovalRules(SIBLING, null).some((r) => r.tool_name === 'Glob'), false);
});

test('only the owner\'s browser can widen an approval', async () => {
  const m = mission(AGENT, owner.id);
  const { card } = ask(m, AGENT, 'NotebookEdit', { notebook_path: 'n' });
  assert.ok(card);
  for (const auth of [
    { kind: 'api-token', userId: owner.id, missionId: m } as Fake,
    { kind: 'daemon-token' } as Fake,
    { kind: 'session', userId: other.id } as Fake,
  ]) {
    const res = await allowWith(card.id, 'always', auth);
    assert.equal(res.status, 403, `${auth.kind} ${auth.userId ?? ''} is refused`);
  }
  assert.equal(listPending(m).some((p) => p.id === card.id), true, 'the card is still waiting');
  assert.equal(dbApi.listAlwaysApprovalRules(AGENT, null).some((r) => r.tool_name === 'NotebookEdit'), false);
  resolvePermission(card.id, { behavior: 'deny', message: 'no' });
});

test('the claude shim never receives a scope', async () => {
  const m = mission(AGENT, owner.id);
  const pending = call('POST', '/api/permissions/request', { kind: 'api-token', userId: owner.id, missionId: m }, {
    mission_id: m, agent: AGENT, tool_name: 'Bash', input: { command: 'npm run typecheck' }, tool_use_id: 'tu-shim',
  });
  let card: ReturnType<typeof listPending>[number] | undefined;
  for (let i = 0; i < 100 && !card; i++) {
    card = listPending(m).find((p) => p.tool_use_id === 'tu-shim');
    if (!card) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(card);
  await allowWith(card.id, 'always');
  const body = await (await pending).json() as Record<string, unknown>;
  assert.equal(body.behavior, 'allow');
  assert.equal('scope' in body, false);
});

test('always approvals are listed to their owner and revoked by them', async () => {
  const m = mission(AGENT, owner.id);
  const { decision, card } = ask(m, AGENT, 'Bash', { command: 'git status' });
  assert.ok(card);
  await allowWith(card.id, 'always');
  await decision;

  // Refusals first.
  assert.equal((await call('GET', `/api/agents/${AGENT}/approvals`, null)).status, 401);
  assert.equal((await call('GET', `/api/agents/${AGENT}/approvals`, { kind: 'api-token', userId: owner.id, missionId: m })).status, 403);
  const theirs = await (await call('GET', `/api/agents/${AGENT}/approvals`, { kind: 'session', userId: other.id })).json() as { approvals: unknown[] };
  assert.deepEqual(theirs.approvals, [], "another user does not see the owner's approvals");

  const listed = await (await call('GET', `/api/agents/${AGENT}/approvals`, ownerSession)).json() as {
    approvals: { id: string; tool_name: string; command: string | null }[];
  };
  const rule = listed.approvals.find((a) => a.command === 'git status');
  assert.ok(rule, 'the owner sees the approval');
  assert.equal(rule.tool_name, 'Bash');

  const path = `/api/agents/${AGENT}/approvals/${rule.id}`;
  assert.equal((await call('DELETE', path, { kind: 'api-token', userId: owner.id, missionId: m })).status, 403, 'an agent cannot revoke');
  assert.equal((await call('DELETE', path, { kind: 'session', userId: other.id })).status, 404, "someone else's rule is not found");
  assert.equal((await call('DELETE', path, ownerSession)).status, 200);

  const after = ask(mission(AGENT, owner.id), AGENT, 'Bash', { command: 'git status' });
  assert.ok(after.card, 'once revoked, the card is back');
  resolvePermission(after.card.id, { behavior: 'deny', message: 'no' });
});

test("deleting the agent takes its approvals with it", async () => {
  const name = 'approvals.ephemeral';
  upsertAgent({ name, system_prompt: 'witness', config: { backend: 'claude', cwd: tmpdir(), skills: [], mcp_servers: [] } });
  const { decision, card } = ask(mission(name, owner.id), name, 'Edit', { file_path: 'a' });
  assert.ok(card);
  await allowWith(card.id, 'always');
  await decision;
  assert.equal(dbApi.listAlwaysApprovalRules(name, null).length, 1);
  assert.equal(deleteAgent(name), true);
  assert.equal(dbApi.listAlwaysApprovalRules(name, null).length, 0);
});

test('an ACP card without scopes of its own gets none from Rooks, and no rule answers it', async () => {
  const m = mission(AGENT, owner.id);
  dbApi.insertApprovalRule({
    id: 'rule-acp', scope: 'always', owner_user_id: owner.id, agent: AGENT, mission_id: null,
    tool_name: 'edit', command: null, command_hash: null,
  });
  const host = permissionHost(m, AGENT, (input) => requestPermission(input));
  const decision = host({ toolCallId: 'tc-acp', tool: 'edit', title: 'Edit a.ts', input: { path: 'a.ts' } });
  const card = listPending(m).find((p) => p.tool_use_id === 'tc-acp');
  assert.ok(card, 'the remembered rule does not answer an ACP request');
  assert.equal(card.scopes, undefined);
  assert.equal(card.remembers, undefined);
  resolvePermission(card.id, { behavior: 'deny', message: 'no' });
  assert.equal((await decision).allow, false);
});
