/**
 * The forms MCP server (`bin/permission-mcp.mjs`), as a model sees it and as
 * the daemon receives it.
 *
 * The server and two of its tools were renamed (`nova_permission` →
 * `nova_ask`, `ask_user` → `question`, `ask_series_plan` → `kanban_plan`) so
 * that an agent asked to plan Kanban work picks the planner. Two promises come
 * with a rename, and both are made by the shim, a standalone script no unit
 * test of an exported function would reach — so this runs the real script
 * against a bounded witness daemon:
 *
 *  1. a former name still answers, and produces the VERY card the current name
 *     produces (a prompt, a memory, a resumed session may name it);
 *  2. a former name is never listed: the same tool twice is a choice the model
 *     gets wrong.
 *
 * What goes to the daemon did not change: the card keeps its persisted
 * identifier, whatever name was called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ASK_MCP_FORMS_ONLY_ENV, ASK_TOOL_KANBAN_PLAN, ASK_TOOL_QUESTION, ASK_TOOL_REQUEST, FORM_CARD_TOOL,
  LEGACY_ASK_TOOLS,
} from './ask-mcp.js';

const SHIM = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'permission-mcp.mjs');

type Posted = { mission_id: string; agent: string; tool_name: string; input: Record<string, unknown>; tool_use_id: string };
type ListedTool = { name: string; description: string };
type RpcReply = {
  id?: number;
  error?: { message: string };
  result?: { tools?: ListedTool[]; isError?: boolean; content?: { text: string }[] };
};

/** Witness daemon: records every card request, answers as the route does once
 *  the human submitted the form. */
function startWitness(): Promise<{ url: string; seen: Posted[]; close: () => Promise<void> }> {
  const seen: Posted[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Posted;
      seen.push(body);
      const updatedInput = body.input.form
        ? { plan: { mode: 'kanban-full', roles: {} }, commands: ['rooks task create …'] }
        : { answers: { 'Which?': 'a' } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ behavior: 'allow', updatedInput }));
    });
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ready({ url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((done) => { server.close(() => done()); }) });
    });
  });
}

/** One JSON-RPC request through the real shim, after `initialize`. The env is
 *  built from scratch: only what is written here reaches the script. */
function rpc(method: string, params: Record<string, unknown>, env: Record<string, string> = {}): Promise<RpcReply> {
  const child = spawn(process.execPath, [SHIM], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, ROOKS_MISSION_ID: 'mission-under-test', ROOKS_AGENT: 'acme.main', ROOKS_API_TOKEN: 'mission-token', ...env },
  });
  const lines = readline.createInterface({ input: child.stdout });
  return new Promise<RpcReply>((resolve_, reject) => {
    // Bounded: the shim retries a network failure forever by design, so a bug
    // must fail this test rather than hang the suite.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`no reply from the shim to ${method} within 10s`));
    }, 10_000);
    lines.on('line', (line) => {
      let msg: RpcReply;
      try { msg = JSON.parse(line) as RpcReply; } catch { return; }
      if (msg.id === 1) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) + '\n');
        return;
      }
      if (msg.id === 2) {
        clearTimeout(timer);
        child.kill('SIGKILL');
        resolve_(msg);
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  });
}

async function listTools(env?: Record<string, string>): Promise<ListedTool[]> {
  const reply = await rpc('tools/list', {}, env);
  assert.equal(reply.error, undefined);
  return reply.result!.tools!;
}

const QUESTIONS = { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'a' }, { label: 'b' }] }] };
const CHANTIER = { chantier: 'Big feature', volets: [{ title: 'Front', group: 'simple' }, { title: 'API', description: 'routes' }] };
const ARGUMENTS: Record<string, Record<string, unknown>> = {
  [ASK_TOOL_QUESTION]: QUESTIONS,
  [ASK_TOOL_KANBAN_PLAN]: CHANTIER,
};

/** What a model sees on a backend whose harness has no use for `request`. */
const FORMS_ONLY = { [ASK_MCP_FORMS_ONLY_ENV]: '1' };

test('tools/list names the current tools only — no former name', async () => {
  const names = (await listTools(FORMS_ONLY)).map((t) => t.name);
  assert.ok(names.includes(ASK_TOOL_QUESTION));
  assert.ok(names.includes(ASK_TOOL_KANBAN_PLAN));
  for (const legacy of Object.keys(LEGACY_ASK_TOOLS)) {
    assert.ok(!names.includes(legacy), `${legacy} must not be listed: it is an alias, not a second tool`);
  }
  assert.deepEqual(names.sort(), [ASK_TOOL_KANBAN_PLAN, ASK_TOOL_QUESTION].sort(), 'nothing else is offered to the model');
});

test('`request` is listed by default, and hidden where no harness calls it', async () => {
  // Default = listed. The script is read from the install directory at every
  // spawn, so a daemon not restarted yet runs it with the environment it
  // always passed: claude's `--permission-prompt-tool` must find its tool.
  const byDefault = (await listTools()).map((t) => t.name);
  assert.deepEqual(byDefault.sort(), [ASK_TOOL_KANBAN_PLAN, ASK_TOOL_QUESTION, ASK_TOOL_REQUEST].sort());
  // Read next to the forms, "ask the UI for permission" is what a model picks
  // to "open a permission request" — on a backend where nothing routes it.
  assert.ok(!(await listTools(FORMS_ONLY)).some((t) => t.name === ASK_TOOL_REQUEST));
});

test('`request` answers even unlisted: the Allow/Deny round trip is unchanged', async () => {
  // Unlisted here on purpose: hiding the tool must never be what breaks it.
  const witness = await startWitness();
  try {
    const reply = await rpc('tools/call', {
      name: ASK_TOOL_REQUEST,
      arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu-1' },
    }, { ROOKS_ORCH_URL: witness.url, ...FORMS_ONLY });
    assert.equal(reply.error, undefined);
    assert.deepEqual(
      witness.seen.map(({ tool_name, input, tool_use_id }) => ({ tool_name, input, tool_use_id })),
      [{ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu-1' }],
      'the tool under arbitration is passed through as it came',
    );
    assert.equal((JSON.parse(reply.result!.content![0]!.text) as { behavior: string }).behavior, 'allow');
  } finally {
    await witness.close();
  }
});

test('each description says when to use its tool, in the words a user says', async () => {
  const tools = await listTools();
  const question = tools.find((t) => t.name === ASK_TOOL_QUESTION)!.description;
  const plan = tools.find((t) => t.name === ASK_TOOL_KANBAN_PLAN)!.description;
  // The two must tell each other apart: the question points at the planner for
  // planning, the planner claims the words the user types.
  assert.match(question, /NOT for planning/);
  assert.match(question, /`kanban_plan`/);
  for (const word of [/Kanban tasks/, /chantier/, /series of tasks/, /parallel/, /models and fallbacks/, /sequential/]) {
    assert.match(plan, word);
  }
  assert.match(plan, /DO NOT ENUMERATE backends or models/);
  // A prompt or a memory written before the rename names the former tool.
  assert.match(question, /Formerly `ask_user`/);
  assert.match(plan, /Formerly `ask_series_plan`/);
});

test('`question` describes the per-question free text and the `actor` badge, and no longer a global note', async () => {
  const tools = await listTools() as Array<ListedTool & { inputSchema: { properties: { questions: { items: { properties: { options: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } } } } } } }>;
  const question = tools.find((t) => t.name === ASK_TOOL_QUESTION)!;
  assert.doesNotMatch(question.description, /"note"/);
  assert.match(question.description, /\{"choice": <label>, "text": <typed>\}/);
  assert.match(question.description, /Example: \{"answers"/);
  const option = question.inputSchema.properties.questions.items.properties.options.items;
  assert.deepEqual(option.properties.actor?.enum, ['agent', 'user']);
  assert.deepEqual(option.required, ['label'], 'an option without `actor` stays valid');
});

for (const [legacy, current] of Object.entries(LEGACY_ASK_TOOLS)) {
  test(`${legacy} is still answered, and opens the same card as ${current}`, async () => {
    const witness = await startWitness();
    try {
      const args = ARGUMENTS[current]!;
      const viaCurrent = await rpc('tools/call', { name: current, arguments: args }, { ROOKS_ORCH_URL: witness.url });
      const viaLegacy = await rpc('tools/call', { name: legacy, arguments: args }, { ROOKS_ORCH_URL: witness.url });
      assert.equal(viaLegacy.error, undefined, 'a former name is not an unknown tool');
      assert.equal(witness.seen.length, 2);
      const [a, b] = witness.seen.map(({ tool_use_id: _id, ...card }) => card);
      assert.deepEqual(b, a, 'same mission, same card name, same payload');
      // The card's name is the persisted one, whichever tool name was called.
      assert.equal(a!.tool_name, FORM_CARD_TOOL);
      assert.deepEqual(viaLegacy.result, viaCurrent.result, 'and the agent reads the same answer');
      assert.notEqual(viaLegacy.result?.isError, true);
    } finally {
      await witness.close();
    }
  });
}

test('the planner posts a typed form, the question posts its questions', async () => {
  const witness = await startWitness();
  try {
    await rpc('tools/call', { name: ASK_TOOL_KANBAN_PLAN, arguments: CHANTIER }, { ROOKS_ORCH_URL: witness.url });
    await rpc('tools/call', { name: ASK_TOOL_QUESTION, arguments: QUESTIONS }, { ROOKS_ORCH_URL: witness.url });
    // `series_plan` is what the UI and past events know the planner's form by.
    assert.deepEqual(witness.seen[0]!.input, { form: { kind: 'series_plan', ...CHANTIER } });
    assert.deepEqual(witness.seen[1]!.input, QUESTIONS);
  } finally {
    await witness.close();
  }
});

test('a volet declares its optional `group`, and the planner says when to propose one', async () => {
  type VoletSchema = { properties: Record<string, { type: string; maxLength?: number; minLength?: number }>; required: string[] };
  const tools = await listTools() as Array<ListedTool & { inputSchema: { properties: { volets: { items: VoletSchema } } } }>;
  const plan = tools.find((t) => t.name === ASK_TOOL_KANBAN_PLAN)!;
  const volet = plan.inputSchema.properties.volets.items;
  assert.equal(volet.properties.group?.type, 'string');
  assert.equal(volet.properties.group?.maxLength, 60, 'same bound as MAX_GROUP_NAME_CHARS in series-plan.ts');
  assert.equal(volet.properties.group?.minLength, 1);
  assert.deepEqual(volet.required, ['title'], 'a volet without `group` stays valid');
  // Groups are for volets of unequal difficulty — and the agent still never
  // names a model, that is the whole point of the form.
  assert.match(plan.description, /differ in difficulty/);
  assert.match(plan.description, /`group`/);
  assert.match(plan.description, /groups\?:/);
});

test('a name that was never a tool is refused', async () => {
  const reply = await rpc('tools/call', { name: 'ask_anything', arguments: {} });
  assert.match(reply.error?.message ?? '', /unknown tool: ask_anything/);
});
