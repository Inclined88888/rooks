/**
 * Duplicating an agent: the copy carries the source's config and prompt, a
 * name already taken is refused (never overwritten — the route upserts), and
 * nothing is written when the source cannot be read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateAgent, duplicateBody, duplicateNameProblem } from './agent-duplicate';

const SOURCE = {
  name: 'alice.coder',
  system_prompt: 'You are Alice.',
  backend: 'codex',
  model: 'gpt-5.5',
  cwd: '/work/alice',
  project: 'alice',
  permission_mode: 'auto',
  allowed_tools: ['Read'],
  disallowed_tools: [],
  skills: ['timon-task'],
  mcp_servers: ['github'],
  excluded_mcp_servers: ['claude_ai_Gmail'],
  memory_scope: 'AGENT',
  role: 'coder',
  directives: 'Be terse.',
  reasoning_effort: 'high',
  global_context: true,
  reports_to: 'alice.lead',
  team: null,
  orchestrator: true,
  orchestrates: ['bob'],
  created_by: 'plugin:x',
};

type Attachment = { id: number; skill: string; scope: 'agent'; target: string; mode: 'include' | 'import'; exclude: boolean };

function fakeApi(opts: { agents?: string[]; source?: object | null; postStatus?: number; attachments?: Attachment[]; attachStatus?: number } = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith('/api/ui/skill-attachments')) {
      if (method === 'POST') {
        const status = opts.attachStatus ?? 200;
        return status === 200 ? Response.json({ ok: true }) : Response.json({ error: 'skill not found' }, { status });
      }
      const target = new URL(url, 'http://x').searchParams.get('target');
      return Response.json({ attachments: (opts.attachments ?? []).filter((a) => a.target === target) });
    }
    if (url === '/api/ui/agents' && method === 'GET') {
      return Response.json({ agents: (opts.agents ?? ['alice.coder']).map((name) => ({ name })) });
    }
    if (url === '/api/ui/agents' && method === 'POST') {
      const status = opts.postStatus ?? 200;
      return status === 200 ? Response.json({ ok: true }) : Response.json({ error: 'forbidden' }, { status });
    }
    if (opts.source === null) return Response.json({ error: 'agent not found' }, { status: 404 });
    return Response.json(opts.source ?? SOURCE);
  };
  return { fetcher, calls };
}

test('a name is refused when empty, malformed, or taken (any case)', () => {
  assert.equal(duplicateNameProblem('  ', []), 'empty');
  assert.equal(duplicateNameProblem('my agent', []), 'invalid');
  assert.equal(duplicateNameProblem('Alice.Coder', ['alice.coder']), 'taken');
  assert.equal(duplicateNameProblem('alice.coder-2', ['alice.coder']), null);
});

test('the copy body carries config and prompt, and none of the protected keys', () => {
  const { name, system_prompt, config } = duplicateBody(SOURCE, 'alice.copy');
  assert.equal(name, 'alice.copy');
  assert.equal(system_prompt, 'You are Alice.');
  assert.deepEqual(config, {
    cwd: '/work/alice',
    project: 'alice',
    backend: 'codex',
    model: 'gpt-5.5',
    permission_mode: 'auto',
    allowed_tools: ['Read'],
    skills: ['timon-task'],
    mcp_servers: ['github'],
    excluded_mcp_servers: ['claude_ai_Gmail'],
    memory_scope: 'AGENT',
    role: 'coder',
    directives: 'Be terse.',
    reasoningEffort: 'high',
    global_context: true,
    reports_to: 'alice.lead',
  });
});

test('an empty exclusion list is still sent, so the copy does not get the connector default-deny', () => {
  const { config } = duplicateBody({ system_prompt: '' }, 'x');
  assert.deepEqual(config.excluded_mcp_servers, []);
});

test('duplicateAgent reads the source then posts the copy', async () => {
  const { fetcher, calls } = fakeApi();
  assert.deepEqual(await duplicateAgent('alice.coder', ' alice.copy ', fetcher), { ok: true, name: 'alice.copy' });
  const post = calls.find((c) => c.method === 'POST');
  assert.equal((post?.body as { name: string }).name, 'alice.copy');
});

test('a taken name is refused without any write, even when the dialog was stale', async () => {
  const { fetcher, calls } = fakeApi({ agents: ['alice.coder', 'Alice.Copy'] });
  assert.deepEqual(await duplicateAgent('alice.coder', 'alice.copy', fetcher), { ok: false, problem: 'taken' });
  assert.equal(calls.some((c) => c.method === 'POST'), false);
});

test('an unreadable source or a refused write is reported, nothing else', async () => {
  const missing = fakeApi({ source: null });
  assert.deepEqual(await duplicateAgent('ghost', 'ghost.copy', missing.fetcher), { ok: false, error: 'agent not found' });
  assert.equal(missing.calls.some((c) => c.method === 'POST'), false);

  const refused = fakeApi({ postStatus: 403 });
  assert.deepEqual(await duplicateAgent('alice.coder', 'alice.copy', refused.fetcher), { ok: false, error: 'forbidden' });
});

test('the copy gets the source\'s own attachments as they are: import stays import, an exclusion stays', async () => {
  const attachments: Attachment[] = [
    { id: 1, skill: 'timon-task', scope: 'agent', target: 'alice.coder', mode: 'include', exclude: false },
    { id: 2, skill: 'deep-procedure', scope: 'agent', target: 'alice.coder', mode: 'import', exclude: false },
    { id: 3, skill: 'inherited-noise', scope: 'agent', target: 'alice.coder', mode: 'include', exclude: true },
    { id: 4, skill: 'someone-else', scope: 'agent', target: 'bob', mode: 'import', exclude: false },
  ];
  const { fetcher, calls } = fakeApi({ source: { ...SOURCE, skills: ['timon-task', 'deep-procedure'] }, attachments });
  assert.deepEqual(await duplicateAgent('alice.coder', 'alice.copy', fetcher), { ok: true, name: 'alice.copy' });
  const posts = calls.filter((c) => c.method === 'POST');
  // The agent first (its `skills` become include rows), then what that list cannot say.
  assert.equal(posts[0]!.url, '/api/ui/agents');
  assert.deepEqual((posts[0]!.body as { config: { skills: string[] } }).config.skills, ['timon-task', 'deep-procedure']);
  assert.deepEqual(posts.slice(1).map((c) => c.body), [
    { skill: 'deep-procedure', scope: 'agent', target: 'alice.copy', mode: 'import', exclude: false },
    { skill: 'inherited-noise', scope: 'agent', target: 'alice.copy', mode: 'include', exclude: true },
  ]);
});

test('an attachment the copy cannot get is reported, the copy still exists', async () => {
  const attachments: Attachment[] = [
    { id: 2, skill: 'deep-procedure', scope: 'agent', target: 'alice.coder', mode: 'import', exclude: false },
  ];
  const { fetcher } = fakeApi({ attachments, attachStatus: 404 });
  assert.deepEqual(await duplicateAgent('alice.coder', 'alice.copy', fetcher), { ok: true, name: 'alice.copy', skillsNotCopied: ['deep-procedure'] });
});

test('unreadable source attachments stop the copy before anything is written', async () => {
  const { fetcher, calls } = fakeApi();
  const failing = async (url: string, init?: RequestInit): Promise<Response> =>
    url.startsWith('/api/ui/skill-attachments') ? Response.json({ error: 'forbidden' }, { status: 403 }) : fetcher(url, init);
  assert.deepEqual(await duplicateAgent('alice.coder', 'alice.copy', failing), { ok: false, error: 'forbidden' });
  assert.equal(calls.some((c) => c.method === 'POST'), false);
});

test('the copy keeps the source\'s face: its mascot look and its picked head', () => {
  const look = { shape: 'gem', color: '#ff5fbf', eyes: 'star', acc: 'globe' };
  const body = duplicateBody({ look, avatar: 'mascot', emoji: '🦊' }, 'nova-2');
  assert.deepEqual(body.config.look, look);
  assert.equal(body.config.avatar, 'mascot');
  assert.equal(body.config.emoji, '🦊');
  const plain = duplicateBody({ look: null, avatar: null }, 'nova-3');
  assert.ok(!('look' in plain.config) && !('avatar' in plain.config), 'nothing written without them');
});
